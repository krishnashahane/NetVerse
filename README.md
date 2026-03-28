# 🌌 Netverse

**Explore the internet as a 3D galaxy.** Netverse crawls websites, maps their link structure, and renders the web as an interactive cosmic visualization in real time.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Three.js](https://img.shields.io/badge/Three.js-0.162-blue) ![License](https://img.shields.io/badge/License-ISC-yellow)

## Features

- **Real-time 3D Web Visualization** — Watch the web unfold as a galaxy powered by Three.js with bloom effects, nebula clouds, and layered star fields
- **Smart Web Crawler** — Breadth-first crawling with configurable depth (1-4), page limits (10-300), and polite rate limiting
- **Force-Directed Layout** — Physics-based graph layout with repulsion, attraction, center gravity, and velocity clamping
- **Interactive Exploration** — Orbit, zoom, click nodes to visit URLs, hover for details, search/filter by domain or keyword
- **Domain Clustering** — Nodes colored by domain with a live domain legend showing distribution
- **Statistics Dashboard** — Live metrics: nodes, edges, domains, errors, elapsed time
- **Minimap** — Bird's-eye overview with camera position indicator
- **Keyboard Shortcuts** — `R` reset view, `H` toggle UI, `F` focus on hovered node

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload during development
npm run dev
```

Open **http://localhost:3000**, enter a URL, and hit **LAUNCH**.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (Three.js)                │
│  ┌───────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ 3D Scene  │  │ Force    │  │ Interactive UI  │  │
│  │ Renderer  │  │ Layout   │  │ Stats/Search    │  │
│  │ + Bloom   │  │ Engine   │  │ Minimap/Legend  │  │
│  └─────┬─────┘  └────┬─────┘  └───────┬─────────┘  │
│        └──────────────┴────────────────┘            │
│                    ↕ Poll /api/graph (800ms)         │
├─────────────────────────────────────────────────────┤
│                   Backend (Express.js)               │
│  ┌───────────┐  ┌──────────┐  ┌─────────────────┐  │
│  │ Crawler   │  │ Graph    │  │ API             │  │
│  │ (BFS +    │  │ Builder  │  │ POST /api/crawl │  │
│  │  cheerio) │  │ (Map +   │  │ POST /api/stop  │  │
│  │           │  │  Set)    │  │ GET  /api/graph │  │
│  │           │  │          │  │ GET  /api/stats │  │
│  └───────────┘  └──────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/crawl` | Start a crawl (`{ url, depth, pages, delay }`) |
| `POST` | `/api/stop` | Stop the active crawl |
| `GET` | `/api/graph` | Get current graph (nodes + edges) |
| `GET` | `/api/stats` | Get crawl statistics |
| `GET` | `/api/health` | Health check |

## Configuration

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Depth | 2 | 1-4 | How many link levels to follow |
| Max Pages | 60 | 10-300 | Maximum pages to crawl |
| Delay | 300ms | 100ms+ | Delay between requests |

## Tech Stack

- **Backend:** Node.js, Express.js 5, Cheerio, node-fetch
- **Frontend:** Three.js (WebGL), Custom GLSL shaders, ES Modules
- **Layout:** Custom force-directed graph with physics simulation

## License

MIT
