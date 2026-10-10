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
 * SearXNG is OPT-IN: it is only enabled when you pass `searxng.baseUrl`
 * or set the SEARXNG_URL environment variable. No queries are ever sent to a
 * third-party instance unless you configure one.
 *
 * Usage:
 *   const s = new EnhancedSearch({
 *     searxng: { baseUrl: "https://my-searxng.fly.dev", engines: "google,bing,brave,ddg" }
 *   });
 */

/** Default safe sub-engines that don't hit datacenter CAPTCHAs */
const DEFAULT_SEARXNG_ENGINES = "bing,wikipedia";

/** Resolve a SearXNG config from explicit config + env. Returns null when not configured. */
export function resolveSearXNGConfig(cfg: SearXNGConfig = {}): SearXNGConfig | null {
  const fromEnv = !cfg.baseUrl && !!process.env.SEARXNG_URL;
  const baseUrl = cfg.baseUrl ?? process.env.SEARXNG_URL;
  if (!baseUrl) return null;
  return {
    ...cfg,
    baseUrl,
    // Only pick up the env token when the URL also came from env, so a token
    // is never sent to a host it was not configured for.
    token:   cfg.token ?? (fromEnv ? process.env.SEARXNG_TOKEN : undefined),
    engines: cfg.engines ?? process.env.SEARXNG_ENGINES ?? DEFAULT_SEARXNG_ENGINES,
  };
}

interface SearXNGResultItem {
  title?: string;
  url?: string;
  content?: string;
  publisheddate?: string;
  engines?: unknown[];
  engine?: unknown;
}

export class SearXNGEngine implements Engine {
  readonly name = "searxng" as const;

  private cfg: SearXNGConfig;

  constructor(cfg: SearXNGConfig = {}) {
    const resolved = resolveSearXNGConfig(cfg);
    if (!resolved) {
      throw new Error("search100x: SearXNGEngine requires searxng.baseUrl (or SEARXNG_URL env)");
    }
    // Copy — never mutate the caller's config object.
    this.cfg = resolved;
  }

  async search(query: string, timeoutMs = 7_000, timeRange?: string): Promise<RawResult[]> {
    const urlsToTry = [
      this.cfg.baseUrl!,
      ...(this.cfg.fallbackUrls ?? []),
    ];

    const perInstanceTimeout = Math.max(1500, Math.floor(timeoutMs / urlsToTry.length));

    let lastError: unknown;
    let anySucceeded = false;
    for (const baseUrl of urlsToTry) {
      // The bearer token is only ever sent to the primary configured host.
      const isPrimary = baseUrl === this.cfg.baseUrl;
      try {
        const results = await this.queryInstance(baseUrl, query, perInstanceTimeout, timeRange, isPrimary);
        anySucceeded = true;
        if (results.length > 0) return results;
      } catch (err) {
        lastError = err;
      }
    }
    // Surface failures so the circuit breaker and engine status can see them.
    if (!anySucceeded && lastError) throw lastError;
    return [];
  }

  private async queryInstance(
    baseUrl: string,
    query: string,
    timeoutMs: number,
    timeRange?: string,
    useAuth = false
  ): Promise<RawResult[]> {
    const cleanBase = baseUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({
      q:        query,
      format:   "json",
      language: this.cfg.language ?? "en",
    });

    if (this.cfg.engines) params.set("engines", this.cfg.engines);
    const tr = timeRange ?? this.cfg.timeRange;
    if (tr) params.set("time_range", tr);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (useAuth && this.cfg.token) {
      headers["Authorization"] = `Bearer ${this.cfg.token}`;
    }

    const res = await http.get(`${cleanBase}/search?${params}`, {
        timeout:      timeoutMs,
        headers,
        responseType: "json",
        // The instance URL is explicitly configured by the user, so a
        // self-hosted instance on localhost / LAN is allowed.
        allowPrivate: true,
      });

      const data = res.data as Record<string, unknown> | undefined;
      const items = (data?.results as SearXNGResultItem[]) ?? [];

      return items.map((r) => {
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
  }
}
