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
 * Self-hosting (recommended — public instances rate-limit aggressively):
 *   fly launch --image searxng/searxng --name my-searxng
 *   fly secrets set SEARXNG_SECRET_KEY=$(openssl rand -hex 32)
 *
 * Usage:
 *   const s = new EnhancedSearch({
 *     searxng: { baseUrl: "https://my-searxng.fly.dev", engines: "google,bing,brave,ddg" }
 *   });
 */
export class SearXNGEngine implements Engine {
  readonly name = "searxng" as const;

  constructor(private cfg: SearXNGConfig) {}

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

        return {
          title:       String(r.title   ?? "").trim(),
          url:         String(r.url     ?? "").trim(),
          snippet:     String(r.content ?? "").trim(),
          subEngines:  Array.isArray(r.engines) ? r.engines.map(String) : [],
          publishedAt,
        } satisfies RawResult;
      }).filter((r) => r.url && r.title);

    } catch {
      return [];
    }
  }
}
