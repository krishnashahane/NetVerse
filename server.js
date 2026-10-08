const express = require("express");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_NODES = 5000;
const MAX_CRAWL_DURATION = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;

const rateBuckets = new Map();
let activeController = null;

function ipv4ToNumber(address) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    parts[0] * 0x1000000 +
    parts[1] * 0x10000 +
    parts[2] * 0x100 +
    parts[3]
  );
}

function isPrivateIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return true;

  return (
    value <= 0x00ffffff ||
    (value >= 0x0a000000 && value <= 0x0affffff) ||
    (value >= 0x64400000 && value <= 0x647fffff) ||
    (value >= 0x7f000000 && value <= 0x7fffffff) ||
    (value >= 0xa9fe0000 && value <= 0xa9feffff) ||
    (value >= 0xac100000 && value <= 0xac1fffff) ||
    (value >= 0xc0000000 && value <= 0xc00000ff) ||
    (value >= 0xc0000200 && value <= 0xc00002ff) ||
    (value >= 0xc0a80000 && value <= 0xc0a8ffff) ||
    (value >= 0xc6120000 && value <= 0xc613ffff) ||
    (value >= 0xc6336400 && value <= 0xc63364ff) ||
    (value >= 0xcb007100 && value <= 0xcb0071ff) ||
    value >= 0xe0000000
  );
}

function ipv4FromMappedIpv6(address) {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return null;

  const suffix = normalized.slice(7);
  if (suffix.includes(".")) return suffix;

  const pieces = suffix.split(":");
  if (pieces.length !== 2) return null;

  const high = Number.parseInt(pieces[0], 16);
  const low = Number.parseInt(pieces[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;

  return [
    (high >> 8) & 255,
    high & 255,
    (low >> 8) & 255,
    low & 255,
  ].join(".");
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped) return isPrivateIpv4(mapped);

  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;

  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);

    if (
      !addresses.length ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      return callback(new Error("Blocked private or reserved network address."));
    }

    const selected = addresses[0];
    return callback(null, selected.address, selected.family);
  });
}

const httpAgent = new http.Agent({ keepAlive: true, lookup: safeLookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: safeLookup });

function agentFor(url) {
  return new URL(url).protocol === "https:" ? httpsAgent : httpAgent;
}

function validateTargetUrl(rawUrl) {
  const target = new URL(rawUrl);

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (target.username || target.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  if (!target.hostname) {
    throw new Error("URL hostname is required.");
  }

  if (isPrivateAddress(target.hostname)) {
    throw new Error("Private and reserved network targets are blocked.");
  }

  return target;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);

    if (!["http:", "https:"].includes(u.protocol)) return null;
    if (u.username || u.password) return null;
    if (isPrivateAddress(u.hostname)) return null;

    u.hash = "";
    u.search = "";

    let normalized = u.toString();
    if (normalized.endsWith("/") && normalized.length > u.origin.length + 1) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

async function readLimitedText(response, maxBytes) {
  const declared = Number.parseInt(
    response.headers.get("content-length") || "",
    10,
  );

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Response body exceeds the size limit.");
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.length;

    if (total > maxBytes) {
      throw new Error("Response body exceeds the size limit.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
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
      const href = $(element).attr("href");
      const resolved = normalizeUrl(href, finalUrl);
      if (resolved) links.add(resolved);
    });

    for (const link of links) {
      if (nodes.size >= MAX_GRAPH_NODES) break;

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

function crawlRateLimit(req, res, next) {
  const now = Date.now();
  const key = requestKey(req);

  if (rateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) {
        rateBuckets.delete(bucketKey);
      }
    }
  }

  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }

  if (bucket.count >= RATE_LIMIT) {
    res.setHeader(
      "Retry-After",
      String(
        Math.max(
          1,
          Math.ceil((RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000),
        ),
      ),
    );
    return res
      .status(429)
      .json({ error: "Too many crawl requests. Try again shortly." });
  }

  bucket.count += 1;
  return next();
}

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

app.post("/api/crawl", crawlRateLimit, (req, res) => {
  const { url, depth, pages, delay } = req.body || {};

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

  const requestedDepth = Number(depth);
  const requestedPages = Number(pages);
  const requestedDelay = Number(delay);

  maxDepth = Math.min(
    Math.max(Number.isFinite(requestedDepth) ? requestedDepth : 2, 1),
    4,
  );
  maxPages = Math.min(
    Math.max(Number.isFinite(requestedPages) ? requestedPages : 60, 1),
    300,
  );
  crawlDelay = Math.min(
    Math.max(Number.isFinite(requestedDelay) ? requestedDelay : 300, 100),
    5000,
  );

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

app.post("/api/stop", (_req, res) => {
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      "\\n  Netverse running at http://localhost:" + String(PORT) + "\\n",
    );
  });
}

module.exports = app;
