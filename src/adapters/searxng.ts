import { Engine } from "../core/engine.js";
import { RawResult, SearXNGConfig } from "../core/types.js";
import { http } from "../core/http.js";

/**
 * SearXNG adapter — queries a self-hosted or public SearXNG instance.
 *
 * SearXNG aggregates ~70 search engines (Google, Bing, Brave, DDG, Yandex,
 * DuckDuckGo, Qwant, Yahoo, Startpage, and many more). Each result carries
 * an `engines` array listing which sub-engines returned it — the container
 * uses this for sub-engine consensus weighting on top of the standard RRF.
 *
 * A default instance is hardcoded so the package works out of the box.
 * Override by passing your own `searxng` config to EnhancedSearch.
 *
 * Usage:
 *   // Default — uses hardcoded instance
 *   const s = new EnhancedSearch();
 *
 *   // Custom instance
 *   const s = new EnhancedSearch({
 *     searxng: { baseUrl: "https://my-searxng.fly.dev", engines: "google,bing,brave,ddg" }
 *   });
 */

/** Default SearXNG instance — hardcoded for zero-config usage. */
const DEFAULT_SEARXNG_BASE_URL = "https://searxng.replit.app";
const DEFAULT_SEARXNG_TOKEN   = "40b5ea00de6d9c6bac9e3844ad1832d6b1a295464cee1c9b148a74fb6626cc63";

export class SearXNGEngine implements Engine {
  readonly name = "searxng" as const;

  constructor(private cfg: SearXNGConfig = {}) {
    // Fall back to hardcoded defaults if not explicitly provided
    this.cfg.baseUrl = this.cfg.baseUrl ?? DEFAULT_SEARXNG_BASE_URL;
    this.cfg.token  = this.cfg.token  ?? DEFAULT_SEARXNG_TOKEN;
  }

  async search(query: string, timeoutMs = 7_000, timeRange?: string): Promise<RawResult[]> {
    const params = new URLSearchParams({
      q:        query,
      format:   "json",
      language: this.cfg.language ?? "en",
    });

    // Engine filter — blank = SearXNG default (all enabled engines)
    if (this.cfg.engines) params.set("engines", this.cfg.engines);

    // Freshness: prefer the per-call timeRange over the config default
    const tr = timeRange ?? this.cfg.timeRange;
    if (tr) params.set("time_range", tr);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.token) headers["Authorization"] = `Bearer ${this.cfg.token}`;

    try {
      const res = await http.get(`${this.cfg.baseUrl}/search?${params}`, {
        timeout:      timeoutMs,
        headers,
        responseType: "json",
      });

      const items: any[] = res.data?.results ?? [];

      return items.map((r: any, i: number) => {
        let publishedAt: Date | undefined;
        if (r.publisheddate) {
          const d = new Date(r.publisheddate);
          if (!isNaN(d.getTime())) publishedAt = d;
        }

        const subEngines: string[] = Array.isArray(r.engines)
          ? r.engines.map(String)
          : (r.engine ? [String(r.engine)] : []);

        return {
          title:       String(r.title   ?? "").trim(),
          url:         String(r.url     ?? "").trim(),
          snippet:     String(r.content ?? "").trim(),
          subEngines,
          publishedAt,
        } satisfies RawResult;
      }).filter((r) => r.url && r.title);

    } catch {
      return [];
    }
  }
}
