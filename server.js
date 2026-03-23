const express = require("express");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const { URL } = require("url");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── CORS support ────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// ── Crawler State ───────────────────────────────────────────────────
const nodes = new Map();       // url -> { id, url, title, domain, depth, linkCount }
const edgeSet = new Set();     // "sourceId->targetId" for O(1) dedup
const edges = [];              // { source, target }
const visited = new Set();
let crawling = false;
let crawlQueue = [];
let nodeIdCounter = 0;
let maxDepth = 2;
let maxPages = 80;
let crawlDelay = 300;
let crawlStartTime = 0;
const MAX_CRAWL_DURATION = 5 * 60 * 1000; // 5 minute overall timeout
let crawlErrors = 0;
let crawlStats = { startedAt: null, finishedAt: null, errors: 0, domains: new Set() };

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
    u.hash = "";
    u.search = "";
    let s = u.toString();
    if (s.endsWith("/") && s.length > u.origin.length + 1) {
      s = s.slice(0, -1);
    }
    return s;
  } catch {
    return null;
  }
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function addNode(url, title, depth) {
  if (nodes.has(url)) return nodes.get(url);
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
  const s = nodes.get(srcUrl);
  const t = nodes.get(tgtUrl);
  if (!s || !t || s.id === t.id) return;
  const key = `${s.id}->${t.id}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push({ source: s.id, target: t.id });
  s.linkCount++;
  t.linkCount++;
}

async function crawlPage(url, depth) {
  if (visited.has(url) || visited.size >= maxPages) return;
  visited.add(url);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Netverse/1.0 (web-galaxy-mapper)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Validate HTTP status
    if (!res.ok) {
      addNode(url, `[${res.status}] ${domainOf(url)}`, depth);
      crawlErrors++;
      return;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return;

    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim().slice(0, 80) || domainOf(url);
    const metaDesc = $('meta[name="description"]').attr("content")?.trim().slice(0, 120) || "";

    const node = addNode(url, title, depth);
    if (metaDesc) node.description = metaDesc;

    const links = new Set();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const resolved = normalizeUrl(href, url);
      if (resolved) {
        links.add(resolved);
      }
    });

    for (const link of links) {
      if (!nodes.has(link)) {
        addNode(link, domainOf(link), depth + 1);
      }
      addEdge(url, link);

      if (depth + 1 <= maxDepth && !visited.has(link) && visited.size < maxPages) {
        crawlQueue.push({ url: link, depth: depth + 1 });
      }
    }
  } catch (err) {
    addNode(url, domainOf(url), depth);
    crawlErrors++;
  }
}

async function runCrawl(seedUrl) {
  // Reset state
  nodes.clear();
  edgeSet.clear();
  edges.length = 0;
  visited.clear();
  crawlQueue = [];
  nodeIdCounter = 0;
  crawlErrors = 0;
  crawling = true;
  crawlStartTime = Date.now();
  crawlStats = { startedAt: new Date().toISOString(), finishedAt: null, errors: 0, domains: new Set() };

  crawlQueue.push({ url: seedUrl, depth: 0 });

  while (crawlQueue.length > 0 && crawling && visited.size < maxPages) {
    // Overall timeout check
    if (Date.now() - crawlStartTime > MAX_CRAWL_DURATION) {
      console.log("Crawl timed out after 5 minutes");
      break;
    }

    const { url, depth } = crawlQueue.shift();
    await crawlPage(url, depth);
    if (crawlDelay > 0) {
      await new Promise((r) => setTimeout(r, crawlDelay));
    }
  }

  crawling = false;
  crawlStats.finishedAt = new Date().toISOString();
  crawlStats.errors = crawlErrors;
}

// ── API Routes ──────────────────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const { url, depth, pages, delay } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  // Validate URL format
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
  }

  // Prevent concurrent crawls
  if (crawling) {
    return res.status(409).json({ error: "A crawl is already in progress. Stop it first." });
  }

  const seedUrl = normalizeUrl(url, "https://placeholder.invalid") || url;
  maxDepth = Math.min(Math.max(depth || 2, 1), 4);
  maxPages = Math.min(Math.max(pages || 80, 10), 300);
  crawlDelay = Math.max(delay ?? 300, 100);

  // Start crawl with error handling
  runCrawl(seedUrl).catch((err) => {
    console.error("Crawl failed:", err);
    crawling = false;
    crawlStats.finishedAt = new Date().toISOString();
    crawlStats.errors++;
  });

  res.json({ status: "started", seedUrl, maxDepth, maxPages });
});

app.post("/api/stop", (_req, res) => {
  crawling = false;
  crawlStats.finishedAt = new Date().toISOString();
  res.json({ status: "stopped", visited: visited.size, nodes: nodes.size, edges: edges.length });
});

app.get("/api/graph", (_req, res) => {
  res.json({
    nodes: Array.from(nodes.values()),
    edges,
    crawling,
    visited: visited.size,
  });
});

app.get("/api/stats", (_req, res) => {
  res.json({
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

// ── Health check ────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🌌 Netverse running at http://localhost:${PORT}\n`);
});
