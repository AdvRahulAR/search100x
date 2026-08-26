# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.2.2] - 2026-08-27

### Fixed
- **Clean CLI Output**: Silenced adapter diagnostics and internal redirect logs in standard CLI runs (enabled only with `DEBUG=1`).

---

## [3.2.1] - 2026-08-27

### Fixed
- **Legal preset engine auto-inclusion**: `indiankanoon`, `indiacode`, and `sebi` are now dynamically activated when `scoringPreset: 'legal'` or `--preset india-legal` is specified.
- **Top legal authority ranking**: Indian Kanoon case law judgments and constitutional petitions now take top rank in CLI output.

---

## [3.2.0] - 2026-08-27

### Added
- **Indian Kanoon adapter** (`src/adapters/indiankanoon.ts`): Dedicated zero-key search for Supreme Court and High Court judgments, headnotes, and court rulings.
- **Legal Entity Chunker** (`src/core/reformulator.ts`): Extracts statutory instruments, constitutional articles, and courts for precision multi-engine keyphrase dispatch.
- **Legal reputation & authority tuning** (`src/core/reputation.ts`): Elevated domain weights for `indiankanoon.org`, `livelaw.in`, `barandbench.com`, `scconline.com`, and `scobserver.in`; added lifestyle/content-farm penalty filters.
- **Domain presets expansion**: Added legal reporters (`livelaw.in`, `barandbench.com`, `scconline.com`, `scobserver.in`) to `DOMAIN_PRESETS['india-legal']`.

---

## [3.1.1] - 2026-08-26

### Fixed
- **Early-return thresholding**: Resolved premature search resolution by counting only successful non-empty engine responses toward `minEngines`.
- **SearXNG Priority & Consensus**: Elevated SearXNG to Tier 1 with 1.30 weight and multi-engine consensus boosting (`subEngines`).
- **Title BM25 relevance**: Enhanced `ResultContainer` to score both titles and body snippets, giving 2x weight to title keyword precision.
- **Publication Date extraction**: Attached parsed `publishedAt` objects in `GoogleNewsEngine` and `BingNewsEngine` for recency decay.
- **CLI tuning flags**: Added `--min-engines`, `--max-wait`, `--deep`, and `--no-early-return` options.

---

### Changed
- Structured logging via `core/logger.ts` — all engine and cache events now emit JSON-compatible log lines
- Scalability improvements: deadline budgeting per engine, backpressure on parallel fetches

---

## [2.2.0] - 2026-06-16

### Added
- **Live intent routing** — detects weather queries at runtime and routes to OpenMeteo instead of web engines
- **OpenMeteo adapter** (`src/adapters/openmeteo.ts`) — free weather API, no key required
- **MMR diversity** (`core/cluster.ts`) — Maximal Marginal Relevance post-processing to reduce result redundancy
- **Query clustering** — groups semantically similar queries before dispatch to avoid redundant engine calls
- **Reputation filter** (`core/reputation.ts`) — down-weights known low-quality domains

---

## [2.0.0] - 2026-06-16

### Added
- **Cascade scoring** — category-aware weight presets (news, legal, academic, general)
- **SearXNG adapter** (`src/adapters/searxng.ts`) — self-hosted metasearch engine support
- **Cross-encoder reranker** (`core/reranker.ts`) — ONNX-based re-ranking, no Python dependency
- **Adaptive timeouts** — per-engine deadline based on historical p95 latency

### Changed
- Engine weights in `scorer.ts` now reflect measured index quality
- `buildQueryBundle()` now emits `scoped` variant for premium engines

---

## [1.3.1] - 2026-06-16

### Fixed
- Repository URLs corrected to `AdvRahulAR/search100x`
- npm package metadata fixes

---

## [1.3.0] - 2026-06-16

### Added
- Initial public release
- 12 search engine adapters: DuckDuckGo, Bing, Mojeek, Google News, Bing News, Wikipedia, OpenAlex, Brave, Tavily, Google, Yep, Marginalia
- RRF + BM25 hybrid scoring
- TTL in-memory cache (`core/cache.ts`)
- Circuit breaker per engine (`core/circuit.ts`)
- Content fetcher / snippet enrichment (`core/fetcher.ts`)
- Domain presets: `india-legal`, `us-legal`, `uk-legal`, `eu-legal`, `au-legal`, `sg-legal`, `academic`
- HTTP API server (`src/server.ts`) on port 3000
- CLI (`src/cli.ts`) — `npx search100x`
- Streaming search via `AsyncGenerator`
- Plugin API: `search.use(engine)` / `search.remove(name)`
