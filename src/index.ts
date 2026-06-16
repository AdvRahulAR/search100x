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
export { ENGINE_WEIGHTS, K, rrfScore, normaliseScores, urlAuthorityScore, recencyScore, cascadeScore, DEFAULT_WEIGHTS, NEWS_WEIGHTS, LEGAL_WEIGHTS, ACADEMIC_WEIGHTS, SCORING_PRESETS } from "./core/scorer.js";
export type { CascadeWeights } from "./core/scorer.js";
export { normalizeUrl, urlKey } from "./core/normalizer.js";
export { bm25Scores, blendScores, BM25_ALPHA, normaliseScores as normaliseBm25Scores } from "./core/bm25.js";
export { SearXNGEngine } from "./adapters/searxng.js";
export type { SearXNGConfig } from "./core/types.js";
export { rerankResults } from "./core/reranker.js";
export { ENGINE_TIMEOUTS } from "./core/engine.js";
export { fetchPageContent, fetchBestPassage, enrichSnippets, fetchRelevantContent, enrichContents } from "./core/fetcher.js";
export { toDocuments, buildCitedQuery } from "./core/documents.js";
export type { CitationDocument, ToDocumentsOptions } from "./core/documents.js";
export { CircuitBreakerRegistry } from "./core/circuit.js";
export type { QueryBundle } from "./core/transformer.js";
export { MarginaliaEngine } from "./adapters/marginalia.js";
export { YepEngine }        from "./adapters/yep.js";
export { OpenMeteoEngine }  from "./adapters/openmeteo.js";
export { clusterResults }    from "./core/cluster.js";
export { reformulateQuery }  from "./core/reformulator.js";
export { domainReputation, spamSignalScore } from "./core/reputation.js";
export { detectLiveIntent } from "./core/classifier.js";
export type { LiveIntent } from "./core/classifier.js";
