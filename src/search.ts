import {
  SearchConfig, SearchOptions, SearchResponse, SearchResult, SourceName,
} from "./core/types.js";
import { Engine } from "./core/engine.js";
import { ResultContainer } from "./core/container.js";
import { buildQueryBundle, QueryBundle, DOMAIN_PRESETS } from "./core/transformer.js";
import { IResultCache, ResultCache, cacheKey } from "./core/cache.js";
import { CircuitBreakerRegistry } from "./core/circuit.js";
import { enrichSnippets, enrichContents } from "./core/fetcher.js";

// Adapters
import { DuckDuckGoEngine } from "./adapters/duckduckgo.js";
import { BingEngine }       from "./adapters/bing.js";
import { MojeekEngine }     from "./adapters/mojeek.js";
import { GoogleNewsEngine } from "./adapters/googlenews.js";
import { BingNewsEngine }   from "./adapters/bingnews.js";
import { WikipediaEngine }  from "./adapters/wikipedia.js";
import { OpenAlexEngine }   from "./adapters/openalex.js";
import { BraveEngine }      from "./adapters/brave.js";
import { TavilyEngine }     from "./adapters/tavily.js";
import { GoogleEngine }     from "./adapters/google.js";

export { DOMAIN_PRESETS }         from "./core/transformer.js";
export { ResultCache, FileResultCache } from "./core/cache.js";

const DEFAULT_TIMEOUT = 7000;
const DEFAULT_LIMIT   = 15;
const DEFAULT_REGION  = "US";

type QueryVariant = keyof Pick<QueryBundle, "primary" | "recent" | "scoped">;

interface EngineEntry {
  engine:  Engine;
  variant: QueryVariant;
}

/**
 * Per-engine timeout wrapper using a shared deadline.
 * The deadline is `Date.now() + totalMs` computed once per search().
 * Each engine gets the REMAINING budget, not the full timeout — fast engines
 * don't inflate the wait time for the overall response.
 */
function withDeadline<T>(promise: Promise<T>, remainingMs: number, label: string): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[search100x] ${label} timed out after ${Math.round(remainingMs)}ms`);
      resolve(null);
    }, remainingMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); })
           .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * EnhancedSearch orchestrator
 * ────────────────────────────
 * Per-request execution model:
 *  1. Cache check — return immediately if query+sources seen within TTL
 *  2. Build query bundle (primary / recent / scoped, timeRange, page)
 *  3. Select active engines; skip those whose circuit breaker is OPEN
 *  4. Run all engines in parallel using a shared deadline budget
 *     When scopedDomains are set, free engines also run the scoped variant
 *  5. Feed results into ResultContainer (merge by URL-hash, BM25+RRF blend)
 *  6. Optionally enrich top-N snippets by fetching actual page content
 *  7. Cache and return
 *
 * Engine instances are created ONCE in the constructor and reused across
 * calls — this enables per-engine state (VQD cache, connection reuse).
 *
 * Plugin API:
 *   s.use(engine)        — register custom engine
 *   s.remove("mojeek")   — disable a built-in engine
 *   s.metrics()          — circuit breaker state per engine
 */
export class EnhancedSearch {
  private config:     SearchConfig;
  private cache:      IResultCache;
  private circuit:    CircuitBreakerRegistry;
  private engineMap:  Map<SourceName, Engine>;
  private plugins:    Engine[] = [];
  private disabled =  new Set<SourceName>();

  constructor(config: SearchConfig = {}) {
    this.config   = { timeoutMs: DEFAULT_TIMEOUT, newsRegion: DEFAULT_REGION, ...config };
    this.cache    = config.cache ?? new ResultCache();
    this.circuit  = new CircuitBreakerRegistry();
    this.engineMap = this.initEngines();
  }

  // ── Plugin API ────────────────────────────────────────────────────────────

  use(engine: Engine): this {
    this.plugins.push(engine);
    return this;
  }

  remove(name: SourceName): this {
    this.disabled.add(name);
    return this;
  }

  metrics(): Record<string, { state: string; failures: number }> {
    return this.circuit.status();
  }

  // ── Batch search ──────────────────────────────────────────────────────────

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const {
      limit      = DEFAULT_LIMIT,
      scopedDomains,
      timeRange,
      page       = 1,
      enrichTopN     = 0,
      enrichContent  = 0,
      noCache        = false,
    } = options;

    const totalTimeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline     = Date.now() + totalTimeout;
    const entries      = this.buildEntries(options.sources, scopedDomains);
    const srcKeys      = entries.map((e) => `${e.engine.name}:${e.variant}`);

    if (!noCache) {
      const key    = cacheKey(query + (timeRange ?? "") + page, srcKeys);
      const cached = this.cache.get(key);
      if (cached) return this.toResponse(query, cached.slice(0, limit), Date.now() - (deadline - totalTimeout));
    }

    const bundle    = buildQueryBundle(query, scopedDomains, timeRange, page);
    const container = new ResultContainer(query);

    await Promise.all(
      entries.map(async ({ engine, variant }) => {
        if (this.circuit.isOpen(engine.name)) {
          console.warn(`[circuit] skipping ${engine.name} (OPEN)`);
          return;
        }
        const remaining = Math.max(1_000, deadline - Date.now());
        const result    = await withDeadline(
          engine.search(bundle[variant], remaining, bundle.timeRange, bundle.page),
          remaining,
          engine.name
        );
        if (result === null) {
          this.circuit.recordFailure(engine.name);
        } else {
          container.add(engine.name, result);
          this.circuit.recordSuccess(engine.name);
        }
      })
    );

    let results = container.getResults(limit);

    if (enrichTopN > 0 && results.length > 0) {
      results = await enrichSnippets(results, enrichTopN, Math.min(totalTimeout, 5_000), query);
    }

    if (enrichContent > 0 && results.length > 0) {
      results = await enrichContents(results, enrichContent, Math.min(totalTimeout, 8_000), query);
    }

    if (!noCache) {
      const key = cacheKey(query + (timeRange ?? "") + page, srcKeys);
      this.cache.set(key, results);
    }

    return this.toResponse(query, results, Date.now() - (deadline - totalTimeout));
  }

  // ── Streaming search ──────────────────────────────────────────────────────

  /**
   * Yields result snapshots as each engine completes — in COMPLETION ORDER,
   * not declaration order.  Fast engines surface results immediately; slow
   * engines don't block the stream.
   */
  async *searchStream(
    query:   string,
    options: SearchOptions = {}
  ): AsyncGenerator<SearchResult[]> {
    const { limit = DEFAULT_LIMIT, scopedDomains, timeRange, page = 1 } = options;
    const totalTimeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline     = Date.now() + totalTimeout;
    const bundle       = buildQueryBundle(query, scopedDomains, timeRange, page);
    const entries      = this.buildEntries(options.sources, scopedDomains);
    const container    = new ResultContainer(query);

    // Each job resolves to its own index when complete (success or timeout).
    // This lets us race them in completion order below.
    const jobs = entries.map(({ engine, variant }, i) =>
      (async (): Promise<number> => {
        if (!this.circuit.isOpen(engine.name)) {
          const remaining = Math.max(1_000, deadline - Date.now());
          const result    = await withDeadline(
            engine.search(bundle[variant], remaining, bundle.timeRange, bundle.page),
            remaining,
            engine.name
          );
          if (result === null) {
            this.circuit.recordFailure(engine.name);
          } else {
            container.add(engine.name, result);
            this.circuit.recordSuccess(engine.name);
          }
        }
        return i;
      })().catch(() => i) // never let a job crash the generator
    );

    // Drain in completion order: whichever engine finishes first yields first.
    const remaining = new Map(jobs.map((p, i) => [i, p]));
    while (remaining.size > 0) {
      const idx = await Promise.race(remaining.values());
      remaining.delete(idx);
      const snapshot = container.getResults(limit);
      if (snapshot.length > 0) yield snapshot;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private toResponse(
    query: string,
    results: SearchResult[],
    durationMs: number
  ): SearchResponse {
    const srcNames = [...new Set(results.flatMap((r) => r.sources))] as SourceName[];
    return { query, results, count: results.length, sources: srcNames, durationMs };
  }

  /** Create one engine instance per built-in source. Called once in constructor. */
  private initEngines(): Map<SourceName, Engine> {
    const { newsRegion = DEFAULT_REGION, braveApiKey, tavilyApiKey, googleApiKey, googleCx } = this.config;
    const m = new Map<SourceName, Engine>();

    m.set("duckduckgo", new DuckDuckGoEngine());
    m.set("bing",       new BingEngine(newsRegion));
    m.set("mojeek",     new MojeekEngine());
    m.set("googlenews", new GoogleNewsEngine(newsRegion));
    m.set("bingnews",   new BingNewsEngine(newsRegion));
    m.set("wikipedia",  new WikipediaEngine());
    m.set("openalex",   new OpenAlexEngine());

    if (tavilyApiKey)           m.set("tavily", new TavilyEngine(tavilyApiKey));
    if (braveApiKey)            m.set("brave",  new BraveEngine(braveApiKey));
    if (googleApiKey && googleCx) m.set("google", new GoogleEngine(googleApiKey, googleCx));

    return m;
  }

  private buildEntries(requested?: SourceName[], scopedDomains?: string[]): EngineEntry[] {
    const DEFAULT_EXCLUDED: SourceName[] = ["openalex"];
    const VARIANT: Record<SourceName, QueryVariant> = {
      duckduckgo: "primary",
      bing:       "primary",
      mojeek:     "primary",
      googlenews: "recent",
      bingnews:   "primary",
      wikipedia:  "primary",
      openalex:   "primary",
      tavily:     "primary",
      brave:      "scoped",
      google:     "primary",
    };

    const base: EngineEntry[] = requested
      ? requested.flatMap((name) => {
          const engine = this.engineMap.get(name);
          return engine ? [{ engine, variant: VARIANT[name] }] : [];
        })
      : [...this.engineMap.entries()]
          .filter(([name]) => !DEFAULT_EXCLUDED.includes(name) && !this.disabled.has(name))
          .map(([name, engine]) => ({ engine, variant: VARIANT[name] }));

    const pluginEntries: EngineEntry[] = this.plugins.map((e) => ({
      engine: e, variant: "primary" as QueryVariant,
    }));

    // Parallel scoped variant for free web engines when scopedDomains provided
    const scopedEntries: EngineEntry[] = [];
    if (scopedDomains && scopedDomains.length > 0 && !requested) {
      const freeWeb: SourceName[] = ["duckduckgo", "bing", "mojeek"];
      for (const entry of base) {
        if (freeWeb.includes(entry.engine.name as SourceName)) {
          scopedEntries.push({ engine: entry.engine, variant: "scoped" });
        }
      }
    }

    return [...base, ...pluginEntries, ...scopedEntries];
  }
}
