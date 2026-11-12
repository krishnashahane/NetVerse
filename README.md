# NetVerse

NetVerse is a bounded public-web crawler that visualizes discovered hyperlinks as an interactive 3D galaxy. It uses Node.js, Express, Cheerio, and Three.js.

NetVerse is intended for sites you are authorized to crawl. It is not a general internet scanner and is designed to reject private and special-purpose network destinations.

## Features

- Interactive Three.js graph with domain colouring, search, node inspection, statistics, and a minimap.
- Breadth-first crawling with configurable depth, page count, and polite delay.
- Manual redirect handling; every redirect is revalidated before the next request.
- DNS resolution validation at connection time to reduce DNS-rebinding and SSRF exposure.
- Bounded response sizes, per-page link extraction, crawl duration, graph nodes, and graph edges.
- Crawl cancellation and request timeouts.
- Rate-limited crawl control endpoints.
- No database or account system; a single in-memory crawl is shared by the running process.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```bash
git clone https://github.com/krishnashahane/NetVerse.git
cd NetVerse
npm ci
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Development mode:

```bash
npm run dev
```

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/crawl` | Start a bounded crawl |
| POST | `/api/stop` | Stop the active crawl and abort the current request |
| GET | `/api/graph` | Return current graph nodes and edges |
| GET | `/api/stats` | Return crawl statistics |

Start a crawl:

```bash
curl -X POST http://localhost:3000/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","depth":2,"pages":60,"delay":300}'
```

## Resource limits

| Resource | Limit |
|---|---:|
| JSON request body | 32 KB |
| Seed/normalized URL | 2,048 characters |
| Crawl depth | 1–4 |
| Pages visited | 1–300 |
| Delay between pages | 100–5,000 ms |
| Redirects per page | 5 |
| Request timeout | 8 seconds |
| Crawl duration | 5 minutes |
| HTML response body | 2 MB |
| Links considered per page | 1,000 |
| Graph nodes | 5,000 |
| Graph edges | 20,000 |
| Rate-limit buckets per process | 5,000 |
| Crawl start/stop requests per client | 10 per minute |

The 3D force layout uses exact all-pairs repulsion for smaller graphs and bounded neighbour sampling above 350 nodes. This keeps the high-node-count view responsive at the cost of approximate physical layout.

## Security

Arbitrary URL fetching makes SSRF prevention a critical boundary.

- Only HTTP and HTTPS targets are accepted.
- URL credentials, oversized URLs, private IPs, and special-purpose addresses are rejected.
- IPv4 and IPv6 checks include loopback, private, link-local, shared, documentation, multicast, reserved, IPv4-mapped IPv6, 6to4, and other non-global ranges.
- DNS lookups reject a hostname if any returned address is private/reserved. The HTTP(S) agents use the same validation at connection time.
- Redirects are handled manually, limited to five hops, and revalidated.
- Response bodies are bounded while streaming; oversized or failed streams are destroyed.
- ZIP files are not accepted; repository crawling fetches public HTTP(S) pages only.
- Crawl control endpoints have bounded per-process rate-limit state.
- Graph, response, request, and link-extraction growth is bounded.
- Security headers are applied before static content and API routes.
- Express fingerprinting is disabled; malformed/oversized JSON receives structured client errors.
- Browser-controlled text is written through DOM text APIs rather than interpolated as HTML.

The address policy deliberately blocks special-use ranges conservatively. Network access controls are defense-in-depth; deploy behind an egress firewall that independently denies private, metadata, and reserved destinations.

## Deployment model and limitations

- The graph and crawl controller are process-local and shared by all visitors of that process. Only one crawl may run at a time.
- Restarting the server clears the graph.
- Multiple instances do not share crawl state. A multi-instance deployment needs a job queue and shared state store, plus distributed rate limiting.
- The crawler does not implement `robots.txt` enforcement. Respect each site's terms, crawl policy, and request limits.
- HTML extraction is limited to a 2 MB response and a fixed number of links per page.

For production deployment, use a reverse proxy with TLS, connection/request timeouts, an egress firewall, process supervision, structured logs, metrics, and alerting. Configure the platform's trusted proxy settings only when the application is actually behind a controlled proxy; otherwise use the direct socket address for rate limiting.

## Tests

```bash
npm ci
npm test
npm audit --audit-level=high
```

The suite checks network-address policy, URL normalization, API validation, error handling, security headers, and the original server smoke checks. GitHub Actions runs on Node.js 22 and 24.

## License

MIT.
