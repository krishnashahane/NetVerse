# Netverse

Netverse is a local Node.js application that crawls public web pages and visualizes the discovered hyperlink graph as an interactive 3D galaxy.

## How it works

1. You provide an HTTP or HTTPS seed URL.
2. The server validates the target and resolves DNS before making the request.
3. Private, loopback, link-local, multicast, documentation, and other reserved IP ranges are blocked.
4. Redirects are followed manually with a strict five-hop limit; every redirect is validated again.
5. Only HTML/XHTML responses are parsed, with a 2 MB response-body limit.
6. Cheerio extracts links, titles, and descriptions.
7. The crawler follows links breadth-first up to the configured depth/page limit.
8. The browser polls the graph API and renders nodes, edges, domains, search results, statistics, and a minimap with Three.js.

Netverse is deliberately a **bounded public-web crawler**. It is not a general internet scanner and does not attempt to access private infrastructure.

## Features

- Interactive Three.js 3D graph
- Breadth-first crawling
- Configurable depth (1–4) and page count (1–300)
- Configurable polite request delay (100–5000 ms)
- Domain clustering and live statistics
- Search/filter and node inspection
- Crawl cancellation with request abort
- Five-minute crawl timeout
- 5,000-node graph safety cap
- 2 MB per-page response cap

## Requirements

- Node.js 22+
- npm

Cheerio 1.2.0 currently requires Node 20.18.1+, so the project targets Node 22 for a current supported runtime. citeturn449058search0turn449058search2

## Installation

~~~bash
git clone https://github.com/krishnashahane/netverse.git
cd netverse
npm install
~~~

Run the application:

~~~bash
npm start
~~~

Development mode:

~~~bash
npm run dev
~~~

Open `http://localhost:3000`.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/crawl` | Start a bounded crawl |
| POST | `/api/stop` | Stop the active crawl and abort the current request |
| GET | `/api/graph` | Return current nodes and edges |
| GET | `/api/stats` | Return crawl statistics |

### Start a crawl

~~~json
{
  "url": "https://example.com",
  "depth": 2,
  "pages": 60,
  "delay": 300
}
~~~

### Limits

- Depth: 1–4
- Pages: 1–300
- Delay: 100–5000 ms
- HTML response: 2 MB
- Graph: 5,000 nodes
- Redirects: 5 per page
- Crawl runtime: 5 minutes
- Crawl start/stop requests: 10 per minute per client

## Security

Netverse accepts arbitrary public URLs, so SSRF protection is a core security boundary.

- HTTP and HTTPS only
- URL credentials are rejected
- DNS results are checked for private/reserved addresses
- The actual HTTP(S) agents use the same DNS safety check at connection time
- Redirects are manual and revalidated
- `file:`, `ftp:`, `gopher:`, and other non-HTTP schemes are rejected
- Request bodies are capped at 32 KB
- Crawl-control endpoints are rate-limited
- Response bodies are capped before parsing
- Graph growth is bounded
- Temporary network requests are abortable
- Express fingerprinting is disabled
- Security response headers are set
- Frontend crawl data/errors are rendered with DOM APIs rather than interpolated into `innerHTML`

### Dependency hardening

The lockfile is overridden to patched `proxy-addr` 2.0.8 and `qs` 6.16.0. `proxy-addr` versions before 2.0.8 have a critical IPv4-mapped-IPv6 trust-subnet spoofing issue (CVE-2026-90711). citeturn928461search1

`qs` versions through 6.15.3 are affected by two 2026 denial-of-service/limit-bypass advisories; 6.16.0 is the patched release. citeturn928461search0turn928461search5

## Important crawler behavior

Netverse removes URL fragments and query strings before graphing pages. It also deduplicates nodes and edges.

The crawler does not currently implement robots.txt enforcement. Use it only against sites you are authorized to crawl and keep the configured request delay respectful.

Because the graph is held in process memory, restarting the server clears the current crawl.

## Testing

Run the local smoke tests:

~~~bash
npm test
~~~

The smoke test verifies that the server starts, `/api/health` works, private `127.0.0.1` targets are rejected, and non-HTTP schemes are rejected.

## Project structure

~~~text
netverse/
├── public/
│   └── index.html
├── server.js
├── package.json
├── package-lock.json
├── test/
│   └── smoke.js
├── .gitignore
└── LICENSE
~~~

## License

MIT
