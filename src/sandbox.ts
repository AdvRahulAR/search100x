/**
 * search100x Sandbox & Isomorphic Search Runtime
 *
 * Lightweight, zero-filesystem entry point designed for constrained environments:
 * - Web Workers & Browser Sandboxes
 * - Cloudflare Workers & Deno
 * - Electron & Browser Extensions
 * - Node.js micro-VMs and serverless sandboxes
 *
 * Runs completely in-memory with zero local file system dependencies.
 */

import { EnhancedSearch, DOMAIN_PRESETS, ResultCache } from "./search.js";
import { fetchRelevantContent, fetchPageContent } from "./core/fetcher.js";
import { SearchConfig, SearchOptions, SearchResponse, SearchResult, SourceName } from "./core/types.js";

export interface SandboxSearchOptions extends SearchOptions {
  /** Optional timeout for the overall search */
  timeoutMs?: number;
}

/**
 * Creates an EnhancedSearch instance guaranteed to run without filesystem access.
 * Uses an in-memory Map cache and browser/sandbox-safe HTTP settings.
 */
export function createSandboxSearch(config: SearchConfig = {}): EnhancedSearch {
  const inMemoryCache = config.cache ?? new ResultCache(300_000);

  return new EnhancedSearch({
    timeoutMs: 6_000,
    newsRegion: "US",
    cache: inMemoryCache,
    ...config,
  });
}

/** Default singleton sandbox search instance */
let defaultSandboxInstance: EnhancedSearch | undefined;

function getSandboxSearch(): EnhancedSearch {
  if (!defaultSandboxInstance) {
    defaultSandboxInstance = createSandboxSearch();
  }
  return defaultSandboxInstance;
}

/**
 * Execute a fast, keyless multi-source search inside any sandbox runtime.
 *
 * @param query Search query string
 * @param options Search options (limit, preset, sources, etc.)
 */
export async function isomorphicSearch(
  query: string,
  options: SandboxSearchOptions = {}
): Promise<SearchResponse> {
  const searcher = getSandboxSearch();
  return searcher.search(query, options);
}

/**
 * Fetch and extract grounded content/passages inside any sandbox runtime.
 *
 * @param url Target webpage URL
 * @param query Optional focus query to run BM25 passage ranking against
 * @param options Extraction options (maxChars, timeoutMs)
 */
export async function isomorphicRead(
  url: string,
  query?: string,
  options: { maxChars?: number; timeoutMs?: number } = {}
): Promise<string | undefined> {
  const { maxChars = 3_000, timeoutMs = 6_000 } = options;
  if (query) {
    return fetchRelevantContent(url, query, { maxChars, timeoutMs });
  }
  return fetchPageContent(url, timeoutMs, maxChars);
}

export { DOMAIN_PRESETS };
export type { SearchResponse, SearchResult, SourceName, SearchConfig, SearchOptions };
