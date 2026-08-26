// ─────────────────────────────────────────────────────────────────────────────
// Primitive result returned by every engine adapter.
// Engines produce a ranked list of these; the merger/scorer handles the rest.
// ───────────────────────────────────────────────────────────────────────────────

export interface RawResult {
  title:       string;
  url:         string;
  snippet:     string;
  /** SearXNG only: names of sub-engines that returned this result (e.g. ["google","bing"]) */
  subEngines?: string[];
  /** Publication date — populated by news adapters and SearXNG */
  publishedAt?: Date;
  providerScore?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// One engine's contribution to a merged result.
// rank is 1-indexed (first result from that engine = 1).
// ─────────────────────────────────────────────────────────────────────────────

export interface Appearance {
  engine: string;
  weight: number;
  rank: number;
  providerScore?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// A result after merging across engines.
// ─────────────────────────────────────────────────────────────────────────────

export interface MergedResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
  appearances: Appearance[];
}

// ────────────────────────────────────────────────────────────────────────────
// Public API surface
// ───────────────────────────────────────────────────────────────────────────

export type SourceName =
  | "duckduckgo"
  | "bing"
  | "mojeek"
  | "googlenews"
  | "bingnews"
  | "wikipedia"
  | "openalex"
  | "brave"
  | "tavily"
  | "google"
  | "searxng"
  | "marginalia"
  | "yep"
  | "openmeteo"
  | "indiacode"
  | "sebi";

/** Coarse category of a search result — set by the engine that found it. */
export type ResultType = "web" | "news" | "academic" | "encyclopedia";

export interface SearchResult {
  title:    string;
  url:      string;
  snippet:  string;
  score:    number;
  sources:  SourceName[];
  /**
   * Full relevant content extracted from the page, populated only when
   * enrichContent > 0 is passed to search(). Multiple BM25-scored passages
   * are concatenated in document order. Use toDocuments() to format for
   * the Claude Citations API.
   */
  content?: string;
  /** Publication date parsed from news RSS feeds. Undefined for web results. */
  publishedAt?: Date;
  /** Coarse result category set by the engine: web / news / academic / encyclopedia. */
  type?: ResultType;
  // ── Phase 4.6: Content provenance metadata ──
  /** Timestamp when this result's content was fetched (epoch ms). Undefined if not enriched. */
  fetchedAt?: number;
  /** Source classification — auto-detected from URL domain. */
  sourceType?: "government" | "news" | "academic" | "legal-database" | "general";
  /** Domain authority score (0–1) — derived from TLD + reputation map. */
  authorityScore?: number;
  /** Freshness classification — determined from query type. */
  freshness?: "realtime" | "recent" | "evergreen";
}

export interface SearXNGConfig {
  /** Base URL of your SearXNG instance, e.g. "https://searx.example.com". Defaults to hardcoded instance. */
  baseUrl?:    string;
  /** Bearer token if your instance requires Authorization header */
  token?:     string;
  /** Comma-separated sub-engines to enable, e.g. "google,bing,brave,ddg" — blank = all */
  engines?:   string;
  /** BCP-47 language code, default "en" */
  language?:  string;
  /** Native freshness filter passed to SearXNG */
  timeRange?: "day" | "week" | "month" | "year";
}

export interface SearchConfig {
  braveApiKey?: string;
  tavilyApiKey?: string;
  googleApiKey?: string;
  googleCx?: string;
  timeoutMs?: number;
  /**
   * ISO 3166-1 alpha-2 country code used by news engines and Bing market.
   * Examples: "US", "IN", "GB", "DE", "AU". Defaults to "US".
   */
  newsRegion?: string;
  /**
   * Custom cache backend.  Defaults to in-memory ResultCache.
   * Use FileResultCache for persistence across process restarts.
   */
  cache?: import("./cache.js").IResultCache;
  /** Self-hosted or public SearXNG instance — adds ~70 sub-engines in one call */
  searxng?: SearXNGConfig;
  logger?: Logger;
}

/**
 * Time-range filter passed to engines that support native freshness parameters.
 * Maps to:  DDG → df=d/w/m,  Bing → freshness=Day/Week/Month
 * Engines that don't support time-range ignore it silently.
 */
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchOptions {
  limit?: number;
  sources?: SourceName[];
  /**
   * Restrict a parallel scoped query to these domains (site: operator).
   * Free web engines run both primary AND scoped variants when this is set.
   *
   * Use DOMAIN_PRESETS from transformer.ts for named shorthands.
   */
  scopedDomains?: string[];
  /**
   * Filter results to a recent time window using each engine's native
   * freshness parameter — NOT by appending years to the query.
   */
  timeRange?: TimeRange;
  /**
   * Result page (1-indexed). Maps to each engine's pagination mechanism.
   * Default: 1
   */
  page?: number;
  /** Fetch best passage from top-N pages and replace snippet (default: 0 = off) */
  enrichTopN?: number;
  /**
   * Fetch ALL relevant passages from top-N pages and populate result.content
   * (default: 0 = off). Use with toDocuments() for Claude Citations API.
   * Runs in parallel with enrichTopN if both are set.
   */
  enrichContent?: number;
  /** Skip result cache for this query (default: false) */
  noCache?: boolean;
  /**
   * Scoring preset — adjusts the 4-factor cascade weights.
   * "default"  → general web (rrf×0.45, bm25×0.30, authority×0.15, recency×0.10)
   * "news"     → freshness-weighted (recency×0.25)
   * "legal"    → authority + term precision, near-zero recency
   * "academic" → authority-heavy, term precision high
   */
  scoringPreset?: "default" | "news" | "legal" | "academic";
  /**
   * Re-rank top-N results using a cross-encoder model after RRF+BM25 scoring.
   * Requires onnxruntime-node and the bundled ONNX model. Default: false.
   */
  rerank?: boolean;
  /** Number of candidates passed to the cross-encoder (default: 20) */
  rerankCandidates?: number;
  /** Enable multi-variant query fan-out for higher recall (default: false) */
  reformulate?: boolean;

  // ── Phase 1.3: Early-return strategy ──
  /** Return as soon as this many results are collected (default: 5) */
  minResults?: number;
  /** Minimum number of engines that must respond before returning (default: 3) */
  minEngines?: number;
  /** Hard timeout — return whatever we have at this point (default: 3000) */
  maxWaitMs?: number;
  /** Enable deep mode — query tier-3 slow engines (default: false) */
  deep?: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  count: number;
  sources: SourceName[];
  durationMs: number;
}

export interface Logger {
  warn(msg: string): void;
  log(msg: string): void;
  debug?(msg: string): void;
}

// ── Phase 4.7: Query classification ──
export type QueryClassification = "legal" | "news" | "academic" | "general";

// ── Phase 1.4: Engine tiers ──
export const ENGINE_TIERS = {
  tier1: ["wikipedia", "duckduckgo", "bing", "googlenews"] as const,
  tier2: ["mojeek", "brave", "bingnews", "searxng"] as const,
  tier3: ["marginalia", "yep", "indiacode", "sebi", "openalex"] as const,
} as const;
