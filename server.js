const express = require("express");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const { URL } = require("url");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Crawler State ───────────────────────────────────────────────────
const nodes = new Map(); // url -> { id, url, title, domain, depth, size }
const edges = []; // { source, target }
const visited = new Set();
let crawling = false;
let crawlQueue = [];
let nodeIdCounter = 0;
let maxDepth = 2;
let maxPages = 80;
let crawlDelay = 300;

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
    u.hash = "";
    u.search = "";
    // strip trailing slash for consistency
    let s = u.toString();
    if (s.endsWith("/") && s.length > u.origin.length + 1) {
      s = s.slice(0, -1);
    }
    return s;
  } catch {
    return null;
  }
}

function addNode(url, title, depth) {
  if (nodes.has(url)) return nodes.get(url);
  const node = {
    id: nodeIdCounter++,
    url,
    title: title || domainOf(url),
    domain: domainOf(url),
    depth,
    linkCount: 0,
  };
  nodes.set(url, node);
  return node;
}

function addEdge(srcUrl, tgtUrl) {
  const s = nodes.get(srcUrl);
  const t = nodes.get(tgtUrl);
  if (!s || !t || s.id === t.id) return;
  // avoid duplicate edges
  if (edges.some((e) => e.source === s.id && e.target === t.id)) return;
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

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return;

    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim().slice(0, 60) || domainOf(url);

    addNode(url, title, depth);

    const links = new Set();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const resolved = normalizeUrl(href, url);
      if (
        resolved &&
        (resolved.startsWith("http://") || resolved.startsWith("https://"))
      ) {
        links.add(resolved);
      }
    });

    for (const link of links) {
      if (!nodes.has(link)) {
        const linkTitle = domainOf(link);
        addNode(link, linkTitle, depth + 1);
      }
      addEdge(url, link);

      if (depth + 1 <= maxDepth && !visited.has(link) && visited.size < maxPages) {
        crawlQueue.push({ url: link, depth: depth + 1 });
      }
    }
  } catch (err) {
    // network error — still register the node so the graph shows it
    addNode(url, domainOf(url), depth);
  }
}

async function runCrawl(seedUrl) {
  // Reset state
  nodes.clear();
  edges.length = 0;
  visited.clear();
  crawlQueue = [];
  nodeIdCounter = 0;
  crawling = true;

  crawlQueue.push({ url: seedUrl, depth: 0 });

  while (crawlQueue.length > 0 && crawling && visited.size < maxPages) {
    const { url, depth } = crawlQueue.shift();
    await crawlPage(url, depth);
    if (crawlDelay > 0) {
      await new Promise((r) => setTimeout(r, crawlDelay));
    }
  }

  crawling = false;
}

// ── API Routes ──────────────────────────────────────────────────────
app.post("/api/crawl", (req, res) => {
  const { url, depth, pages, delay } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const seedUrl = normalizeUrl(url, "https://placeholder.invalid") || url;
  maxDepth = Math.min(depth || 2, 4);
  maxPages = Math.min(pages || 80, 300);
  crawlDelay = delay ?? 300;

  // Start crawl in background
  runCrawl(seedUrl);

  res.json({ status: "started", seedUrl, maxDepth, maxPages });
});

app.post("/api/stop", (_req, res) => {
  crawling = false;
  res.json({ status: "stopped" });
});

app.get("/api/graph", (_req, res) => {
  res.json({
    nodes: Array.from(nodes.values()),
    edges,
    crawling,
    visited: visited.size,
  });
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🌌 Netverse running at http://localhost:${PORT}\n`);
});
