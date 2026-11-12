const express = require("express");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const {
  normalizeUrl,
  safeLookup,
  validateTargetUrl,
} = require("./lib/network-policy");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_NODES = 5000;
const MAX_GRAPH_EDGES = 20000;
const MAX_CRAWL_DURATION = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const MAX_RATE_BUCKETS = 5000;
const MAX_LINKS_PER_PAGE = 1000;

const rateBuckets = new Map();
let activeController = null;

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function readLimitedText(response, maxBytes) {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);

  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    response.body?.destroy();
    throw new Error("Response body exceeds the size limit.");
  }

  const chunks = [];
  let total = 0;

  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) {
        response.body?.destroy();
        throw new Error("Response body exceeds the size limit.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    response.body?.destroy();
    throw error;
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchHtml(startUrl) {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    validateTargetUrl(currentUrl);

    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Netverse/2.0 (+https://github.com/krishnashahane/netverse)",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
        redirect: "manual",
        signal: controller.signal,
        agent: agentFor(currentUrl),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        response.body?.destroy();

        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new Error("Too many redirects or missing redirect target.");
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        response.body?.destroy();
        return {
          ok: false,
          status: response.status,
          html: "",
          url: currentUrl,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        response.body?.destroy();
        return {
          ok: false,
          status: response.status,
          html: "",
          url: currentUrl,
        };
      }

      const html = await readLimitedText(response, MAX_HTML_BYTES);

      return {
        ok: true,
        status: response.status,
        html,
        url: currentUrl,
      };
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  }

  throw new Error("Redirect limit exceeded.");
}

const nodes = new Map();
const edgeSet = new Set();
const edges = [];
const visited = new Set();
let crawling = false;
let crawlQueue = [];
let nodeIdCounter = 0;
let maxDepth = 2;
let maxPages = 60;
let crawlDelay = 300;
let crawlStartTime = 0;
let crawlErrors = 0;
let crawlStats = {
  startedAt: null,
  finishedAt: null,
  errors: 0,
  domains: new Set(),
};

function addNode(url, title, depth) {
  if (nodes.has(url)) return nodes.get(url);
  if (nodes.size >= MAX_GRAPH_NODES) return null;

  const domain = domainOf(url);
  const node = {
    id: nodeIdCounter++,
    url,
    title: title || domain,
    domain,
    depth,
    linkCount: 0,
  };

  nodes.set(url, node);
  crawlStats.domains.add(domain);
  return node;
}

function addEdge(srcUrl, tgtUrl) {
  const source = nodes.get(srcUrl);
  const target = nodes.get(tgtUrl);

  if (!source || !target || source.id === target.id) return;
  if (edges.length >= MAX_GRAPH_EDGES) return;

  const key = String(source.id) + "->" + String(target.id);
  if (edgeSet.has(key)) return;

  edgeSet.add(key);
  edges.push({ source: source.id, target: target.id });
  source.linkCount += 1;
  target.linkCount += 1;
}

async function crawlPage(url, depth) {
  if (visited.has(url) || visited.size >= maxPages || !crawling) return;
  visited.add(url);

  try {
    const result = await fetchHtml(url);

    if (!result.ok) {
      addNode(
        url,
        "[" + String(result.status) + "] " + domainOf(url),
        depth,
      );
      crawlErrors += 1;
      return;
    }

    const $ = cheerio.load(result.html);
    const finalUrl = result.url;
    const title =
      $("title").first().text().trim().slice(0, 80) || domainOf(finalUrl);
    const metaDesc =
      $('meta[name="description"]').attr("content")?.trim().slice(0, 120) || "";

    const node = addNode(finalUrl, title, depth);
    if (!node) return;
    if (metaDesc) node.description = metaDesc;

    const links = new Set();

    $("a[href]").each((_, element) => {
      if (links.size >= MAX_LINKS_PER_PAGE) return false;
      const href = $(element).attr("href");
      const resolved = normalizeUrl(href, finalUrl);
      if (resolved) links.add(resolved);
      return undefined;
    });

    for (const link of links) {
      if (nodes.size >= MAX_GRAPH_NODES || edges.length >= MAX_GRAPH_EDGES) break;

      const target = addNode(link, domainOf(link), depth + 1);
      if (target) addEdge(finalUrl, link);

      if (
        depth + 1 <= maxDepth &&
        !visited.has(link) &&
        crawlQueue.length < maxPages * 4
      ) {
        crawlQueue.push({ url: link, depth: depth + 1 });
      }
    }
  } catch (error) {
    crawlErrors += 1;
  }
}

async function runCrawl(seedUrl) {
  nodes.clear();
  edgeSet.clear();
  edges.length = 0;
  visited.clear();
  crawlQueue = [];
  nodeIdCounter = 0;
  crawlErrors = 0;
  crawling = true;
  crawlStartTime = Date.now();
  crawlStats = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: 0,
    domains: new Set(),
  };

  crawlQueue.push({ url: seedUrl, depth: 0 });

  while (
    crawlQueue.length > 0 &&
    crawling &&
    visited.size < maxPages &&
    nodes.size < MAX_GRAPH_NODES
  ) {
    if (Date.now() - crawlStartTime > MAX_CRAWL_DURATION) break;

    const item = crawlQueue.shift();
    if (!item) break;

    await crawlPage(item.url, item.depth);

    if (crawlDelay > 0 && crawling) {
      await new Promise((resolve) => setTimeout(resolve, crawlDelay));
    }
  }

  crawling = false;
  crawlStats.finishedAt = new Date().toISOString();
  crawlStats.errors = crawlErrors;
}

function requestKey(req) {
  return req.socket?.remoteAddress || "unknown";
}

function pruneRateBuckets(now) {
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) {
      rateBuckets.delete(key);
    }
  }
}

function crawlRateLimit(req, res, next) {
  const now = Date.now();
  const key = requestKey(req);
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    if (bucket) rateBuckets.delete(key);
    pruneRateBuckets(now);

    // Keep the per-process limiter bounded even if many source IPs appear.
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
    }

    bucket = { startedAt: now, count: 1 };
    rateBuckets.set(key, bucket);
    return next();
  }

  // Refresh insertion order so the oldest live bucket can be evicted safely.
  rateBuckets.delete(key);
  rateBuckets.set(key, bucket);

  if (bucket.count >= RATE_LIMIT) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000))),
    );
    return res
      .status(429)
      .json({ error: "Too many crawl requests. Try again shortly." });
  }

  bucket.count += 1;
  return next();
}

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; font-src 'self' data: https://cdn.jsdelivr.net; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'",
  );
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
  next();
});

app.use(express.json({ limit: "32kb", strict: true }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: 0,
  fallthrough: true,
}));

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value :
    (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(name + " must be a whole number.");
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

app.post("/api/crawl", crawlRateLimit, (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "A JSON object is required." });
  }

  const { url, depth, pages, delay } = req.body;

  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  let parsed;
  try {
    parsed = validateTargetUrl(url.trim());
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (crawling) {
    return res
      .status(409)
      .json({ error: "A crawl is already in progress. Stop it first." });
  }

  const normalizedSeed = normalizeUrl(parsed.toString(), parsed.toString());
  if (!normalizedSeed) {
    return res.status(400).json({ error: "Invalid crawl URL." });
  }

  try {
    maxDepth = boundedInteger(depth, 2, 1, 4, "depth");
    maxPages = boundedInteger(pages, 60, 1, 300, "pages");
    crawlDelay = boundedInteger(delay, 300, 100, 5000, "delay");
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  runCrawl(normalizedSeed).catch((error) => {
    console.error("Crawl failed:", error.message);
    crawling = false;
    crawlStats.finishedAt = new Date().toISOString();
    crawlStats.errors += 1;
  });

  return res.json({
    status: "started",
    seedUrl: normalizedSeed,
    maxDepth,
    maxPages,
    crawlDelay,
  });
});

app.post("/api/stop", crawlRateLimit, (_req, res) => {
  crawling = false;
  activeController?.abort();
  crawlStats.finishedAt = new Date().toISOString();

  return res.json({
    status: "stopped",
    visited: visited.size,
    nodes: nodes.size,
    edges: edges.length,
  });
});

app.get("/api/graph", (_req, res) => {
  return res.json({
    nodes: Array.from(nodes.values()),
    edges,
    crawling,
    visited: visited.size,
  });
});

app.get("/api/stats", (_req, res) => {
  return res.json({
    crawling,
    visited: visited.size,
    totalNodes: nodes.size,
    totalEdges: edges.length,
    errors: crawlErrors,
    domains: crawlStats.domains.size,
    domainList: Array.from(crawlStats.domains).slice(0, 50),
    startedAt: crawlStats.startedAt,
    finishedAt: crawlStats.finishedAt,
    elapsed: crawlStartTime ? Date.now() - crawlStartTime : 0,
  });
});

app.get("/api/health", (_req, res) => {
  return res.json({ status: "ok", uptime: process.uptime() });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body exceeds the 32 KB limit." });
  }
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON request body." });
  }

  console.error("Unhandled request error:", error?.message || "unknown error");
  return res.status(500).json({ error: "Internal server error." });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log("\\n  Netverse running at http://localhost:" + String(PORT) + "\\n");
  });

  const shutdown = () => {
    crawling = false;
    activeController?.abort();
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = app;
