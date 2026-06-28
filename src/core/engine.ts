import { RawResult, SourceName } from "./types.js";

/**
 * Every adapter must implement this interface.
 * The orchestrator calls search() with the chosen query variant, wraps results
 * in an Appearance, and feeds them into ResultContainer — adapters never touch scoring.
 *
 * timeRange and page are optional extras; adapters that support them should
 * consume them, others silently ignore them.
 */
export interface Engine {
  readonly name: SourceName;
  search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page?: number
  ): Promise<RawResult[]>;
}

/**
 * Per-engine timeout budget in ms.
 * Fast engines (DDG, Wikipedia) are cut sooner to reduce overall p50 latency.
 * SearXNG aggregates ~70 sub-engines and needs a wider window.
 * The orchestrator picks ENGINE_TIMEOUTS[name] over the global timeoutMs.
 */
export const ENGINE_TIMEOUTS: Record<string, number> = {
  duckduckgo: 3_000,
  wikipedia:  2_000,
  googlenews: 2_500,
  bingnews:   2_500,
  bing:       5_000,
  mojeek:     5_000,
  brave:      4_000,
  tavily:     4_000,
  google:     4_000,
  openalex:   4_000,
  searxng:    7_000,
  marginalia: 3_500,
  yep:        4_000,
  // Two sequential HTTP calls (geocode + weather) — needs generous budget
  openmeteo:  6_000,
};
