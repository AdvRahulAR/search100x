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
export { bm25Scores, blendScores, BM25_ALPHA, normaliseScores as normaliseBm25Scores, legalCitations } from "./core/bm25.js";
export { SearXNGEngine } from "./adapters/searxng.js";
export type { SearXNGConfig } from "./core/types.js";
export { rerankResults } from "./core/reranker.js";
export { ENGINE_TIMEOUTS } from "./core/engine.js";
export { fetchPageContent, fetchBestPassage, enrichSnippets, fetchRelevantContent, enrichContents, enrichContentsLegal } from "./core/fetcher.js";
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

export { DuckDuckGoEngine } from "./adapters/duckduckgo.js";
export { BingEngine } from "./adapters/bing.js";
export { MojeekEngine } from "./adapters/mojeek.js";
export { GoogleNewsEngine } from "./adapters/googlenews.js";
export { BingNewsEngine } from "./adapters/bingnews.js";
export { WikipediaEngine } from "./adapters/wikipedia.js";
export { OpenAlexEngine } from "./adapters/openalex.js";
export { BraveEngine, BraveFreeEngine } from "./adapters/brave.js";
export { TavilyEngine } from "./adapters/tavily.js";
export { GoogleEngine } from "./adapters/google.js";

// v3.0.0 exports
export { IndiaCodeEngine, SebiEngine } from "./adapters/indiacode.js";
export { IndianKanoonEngine } from "./adapters/indiankanoon.js";
export { WikipediaFullTextEngine, DuckDuckGoLiteEngine, GoogleNewsIndiaEngine } from "./adapters/enhanced-engines.js";
export { extractContent, extractPdfText, isPdfContentType } from "./core/extractor.js";
export { ConnectionPool, globalPool, pMap } from "./core/pool.js";
export {
  contentSimhash, hamming64, dedupByContent,
  SemanticCache, freshnessTtl, isCacheFresh,
} from "./core/simhash.js";
export type { DedupResult } from "./core/simhash.js";
export {
  isSsrfSafe, isRedirectSafe, detectPromptInjection, BloomFilter, lostInTheMiddleRerank,
} from "./core/security.js";
export type { SsrfCheckResult, InjectionCheckResult } from "./core/security.js";

// v3.1.0 exports — provenance, classification, tiers
export { classifySourceType, addProvenance } from "./core/fetcher.js";
export { ENGINE_TIERS } from "./core/types.js";
export type { QueryClassification } from "./core/types.js";

// v4.0.0 exports — stealth, legal metadata, config, mcp
export { getStealthHeaders, getRandomProfile, getPinnedProfile, RateLimiter, globalRateLimiter } from "./core/stealth.js";
export type { BrowserProfile, RateLimitConfig } from "./core/stealth.js";
export { stemToken } from "./core/bm25.js";
export { legalDocTypeBoost } from "./core/scorer.js";
export { setCustomDomainBoosts } from "./core/reputation.js";
export type { LegalMetadata } from "./core/types.js";
export { extractKeyEntities } from "./core/reformulator.js";
export {
  startMcpServer,
  handleJsonRpcMessage,
  handleToolCall,
  MCP_TOOLS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_DEFAULT_SEARCH_LIMIT,
  MCP_MAX_SEARCH_LIMIT,
  MCP_DEFAULT_FETCH_MAX_CHARS,
  MCP_DEFAULT_FETCH_TIMEOUT_MS,
  MCP_DEFAULT_SEARCH_TIMEOUT_MS,
  JURISDICTION_TO_PRESET_MAP,
} from "./mcp.js";
export type {
  McpServerOptions,
  McpServerInstance,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  McpToolInputSchema,
  McpToolProperty,
  McpTextContent,
  McpToolCallResult,
} from "./mcp.js";

