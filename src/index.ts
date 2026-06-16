export { EnhancedSearch, ResultCache, FileResultCache, DOMAIN_PRESETS } from "./search.js";
export { cacheKey } from "./core/cache.js";
export type { IResultCache } from "./core/cache.js";
export type {
  SearchResult,
  SearchConfig,
  SearchOptions,
  SearchResponse,
  SourceName,
  RawResult,
  Appearance,
  MergedResult,
  TimeRange,
  ResultType,
} from "./core/types.js";
export { ENGINE_WEIGHTS, K, rrfScore, normaliseScores } from "./core/scorer.js";
export { normalizeUrl, urlKey } from "./core/normalizer.js";
export { bm25Scores, blendScores, BM25_ALPHA } from "./core/bm25.js";
export { fetchPageContent, fetchBestPassage, enrichSnippets, fetchRelevantContent, enrichContents } from "./core/fetcher.js";
export { toDocuments, buildCitedQuery } from "./core/documents.js";
export type { CitationDocument, ToDocumentsOptions } from "./core/documents.js";
export { CircuitBreakerRegistry } from "./core/circuit.js";
export type { QueryBundle } from "./core/transformer.js";
