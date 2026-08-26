import {
  SearchConfig, SearchOptions, SearchResponse, SearchResult, SourceName, Logger,
} from "./core/types.js";
import { Engine, ENGINE_TIMEOUTS } from "./core/engine.js";
import { ResultContainer } from "./core/container.js";
import { buildQueryBundle, QueryBundle, DOMAIN_PRESETS } from "./core/transformer.js";
import { IResultCache, ResultCache, cacheKey } from "./core/cache.js";
import { CircuitBreakerRegistry } from "./core/circuit.js";
import { enrichSnippets, enrichContents } from "./core/fetcher.js";
import { SCORING_PRESETS, DEFAULT_WEIGHTS } from "./core/scorer.js";
import { rerankResults } from "./core/reranker.js";
import { classifyQuery, detectLiveIntent } from "./core/classifier.js";
import { reformulateQuery } from "./core/reformulator.js";
import { defaultLogger, silentLogger } from "./core/logger.js";

// Adapters
import { DuckDuckGoEngine } from "./adapters/duckduckgo.js";
import { BingEngine }       from "./adapters/bing.js";
import { MojeekEngine }     from "./adapters/mojeek.js";
import { GoogleNewsEngine } from "./adapters/googlenews.js";
import { BingNewsEngine }   from "./adapters/bingnews.js";
import { WikipediaEngine }  from "./adapters/wikipedia.js";
import { OpenAlexEngine }   from "./adapters/openalex.js";
import { BraveEngine, BraveFreeEngine } from "./adapters/brave.js";
import { TavilyEngine }     from "./adapters/tavily.js";
import { GoogleEngine }     from "./adapters/google.js";
import { SearXNGEngine }    from "./adapters/searxng.js";
import { MarginaliaEngine } from "./adapters/marginalia.js";
import { YepEngine }        from "./adapters/yep.js";
import { OpenMeteoEngine }  from "./adapters/openmeteo.js";
import { IndiaCodeEngine, SebiEngine } from "./adapters/indiacode.js";

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

function withDeadline<T>(promise: Promise<T>, remainingMs: number, label: string, logger?: Logger): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger?.warn(`[search100x] ${label} timed out after ${Math.round(remainingMs)}ms`);
      resolve(null);
    }, remainingMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); })
           .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

export class EnhancedSearch {
  private config:     SearchConfig;
  private cache:      IResultCache;
  private circuit:    CircuitBreakerRegistry;
  private engineMap:  Map<SourceName, Engine>;
  private plugins:    Engine[] = [];
  private disabled =  new Set<SourceName>();
  private logger:     Logger;

  constructor(config: SearchConfig = {}) {
    this.config   = { timeoutMs: DEFAULT_TIMEOUT, newsRegion: DEFAULT_REGION, logger: defaultLogger, ...config };
    this.logger   = this.config.logger ?? defaultLogger;
    this.cache    = config.cache ?? new ResultCache();
    this.circuit  = new CircuitBreakerRegistry(this.logger);
    this.engineMap = this.initEngines();
  }

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

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const {
      limit            = DEFAULT_LIMIT,
      scopedDomains,
      timeRange,
      page             = 1,
      enrichTopN       = 0,
      enrichContent    = 0,
      noCache          = false,
      scoringPreset,
      rerank           = false,
      rerankCandidates = 20,
    } = options;

    if (limit < 1 || limit > 100) {
      throw new Error(`search100x: limit must be between 1 and 100, got ${limit}`);
    }

    const autoClass  = classifyQuery(query);
    const preset     = scoringPreset
      ?? (autoClass.confidence > 0.65 ? autoClass.category : "default");

    const resolvedTimeRange = timeRange ?? (preset === "news" ? "week" : undefined);

    const totalTimeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline     = Date.now() + totalTimeout;
    const entries      = this.buildEntries(options.sources, scopedDomains);
    const srcKeys      = entries.map((e) => `${e.engine.name}:${e.variant}`);

    if (!noCache) {
      const key    = cacheKey(query + (resolvedTimeRange ?? "") + page + preset, srcKeys);
      const cached = this.cache.get(key, query, srcKeys);
      if (cached) return this.toResponse(query, cached.slice(0, limit), Date.now() - (deadline - totalTimeout));
    }

    const bundle    = buildQueryBundle(query, scopedDomains, resolvedTimeRange, page);
    const weights   = SCORING_PRESETS[preset] ?? DEFAULT_WEIGHTS;
    const halfLife  = preset === "legal" || preset === "academic" ? 365 : (preset === "news" ? 3 : 30);
    const container = new ResultContainer(query);

    const liveIntent = detectLiveIntent(query);
    let activeEntries = entries;

    const tasks: Promise<void>[] = [];

    let pinnedResult: SearchResult | null = null;

    if (liveIntent === "weather") {
      const weatherEngine = new OpenMeteoEngine();
      const weatherTimeout = ENGINE_TIMEOUTS["openmeteo"] ?? 6_000;
      const weatherResult = await withDeadline(
        weatherEngine.search(query, weatherTimeout),
        weatherTimeout,
        "openmeteo",
        this.logger
      );
      if (weatherResult !== null && weatherResult.length > 0) {
        pinnedResult = {
          title:       weatherResult[0].title,
          url:         weatherResult[0].url,
          snippet:     weatherResult[0].snippet,
          score:       1.0,
          sources:     ["openmeteo"],
          publishedAt: weatherResult[0].publishedAt,
        };
      }
      activeEntries = entries.filter(e =>
        (["googlenews", "bingnews", "tavily", "brave", "google"] as string[]).includes(e.engine.name)
      );
    }

    activeEntries.forEach(({ engine, variant }) => {
      tasks.push((async () => {
        if (this.circuit.isOpen(engine.name)) {
          this.logger.warn(`[circuit] skipping ${engine.name} (OPEN)`);
          return;
        }
        const engineTimeout = ENGINE_TIMEOUTS[engine.name] ?? totalTimeout;
        const remaining     = Math.max(1_000, Math.min(engineTimeout, deadline - Date.now()));
        const result        = await withDeadline(
          engine.search(bundle[variant], remaining, bundle.timeRange, bundle.page),
          remaining,
          engine.name,
          this.logger
        );
        if (result === null) {
          this.circuit.recordFailure(engine.name);
        } else {
          container.add(engine.name, result);
          this.circuit.recordSuccess(engine.name);
        }
      })());
    });

    const shouldReformulate = options.reformulate ?? false;
    const extraQueries = shouldReformulate ? reformulateQuery(query).slice(1) : [];

    extraQueries.forEach((eq) => {
      const eqBundle = buildQueryBundle(eq, scopedDomains, resolvedTimeRange, page);
      const freeWebEngines = ["duckduckgo", "bing", "mojeek", "brave"];
      const activeFreeEntries = entries.filter(e => freeWebEngines.includes(e.engine.name));

      activeFreeEntries.forEach(({ engine, variant }) => {
        tasks.push((async () => {
          if (this.circuit.isOpen(engine.name)) return;
          const engineTimeout = ENGINE_TIMEOUTS[engine.name] ?? totalTimeout;
          const remaining     = Math.max(1_000, Math.min(engineTimeout, deadline - Date.now()));
          const result        = await withDeadline(
            engine.search(eqBundle[variant], remaining, eqBundle.timeRange, eqBundle.page),
            remaining,
            `${engine.name}:${eq}`,
            this.logger
          );
          if (result === null) {
            this.circuit.recordFailure(engine.name);
          } else {
            const sizeBefore = container.size;
            container.add(engine.name, result);
            const sizeAfter = container.size;
            const added = sizeAfter - sizeBefore;
            console.log(`[reformulator] query "${eq}" on ${engine.name} added ${added} unique results.`);
            this.circuit.recordSuccess(engine.name);
          }
        })());
      });
    });

    await Promise.all(tasks);

    const fetchLimit = rerank ? Math.max(limit, rerankCandidates) : limit;
    let results = container.getResults(fetchLimit, weights, halfLife);

    if (pinnedResult) {
      results = [pinnedResult, ...results.filter(r => r.url !== pinnedResult!.url)];
    }

    if (enrichTopN > 0 && results.length > 0) {
      results = await enrichSnippets(results, enrichTopN, Math.min(totalTimeout, 5_000), query);
    }

    if (enrichContent > 0 && results.length > 0) {
      // Auto-detect legal queries and use legal mode: 500-word windows,
      // 12000-char cap, jurisdiction-aware BM25 boost, citation-aware scoring
      const isLegal = preset === "legal";
      const enrichTimeout = Math.min(totalTimeout, isLegal ? 8_000 : 8_000);
      results = await enrichContents(results, enrichContent, enrichTimeout, query, { legalMode: isLegal });
    }

    if (rerank && results.length > 0) {
      results = await rerankResults(query, results, rerankCandidates);
    }

    results = results.slice(0, limit);

    if (!noCache) {
      const key = cacheKey(query + (resolvedTimeRange ?? "") + page + preset, srcKeys);
      this.cache.set(key, results, query, srcKeys);
    }

    return this.toResponse(query, results, Date.now() - (deadline - totalTimeout));
  }

  async *searchStream(
    query:   string,
    options: SearchOptions = {}
  ): AsyncGenerator<SearchResult[]> {
    const { limit = DEFAULT_LIMIT, scopedDomains, timeRange, page = 1 } = options;
    if (limit < 1 || limit > 100) {
      throw new Error(`search100x: limit must be between 1 and 100, got ${limit}`);
    }
    const totalTimeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline     = Date.now() + totalTimeout;
    const bundle       = buildQueryBundle(query, scopedDomains, timeRange, page);
    const entries      = this.buildEntries(options.sources, scopedDomains);
    const container    = new ResultContainer(query);

    const jobs = entries.map(({ engine, variant }, i) =>
      (async (): Promise<number> => {
        if (!this.circuit.isOpen(engine.name)) {
          const remaining = Math.max(1_000, deadline - Date.now());
          const result    = await withDeadline(
            engine.search(bundle[variant], remaining, bundle.timeRange, bundle.page),
            remaining,
            engine.name,
            this.logger
          );
          if (result === null) {
            this.circuit.recordFailure(engine.name);
          } else {
            container.add(engine.name, result);
            this.circuit.recordSuccess(engine.name);
          }
        }
        return i;
      })().catch(() => i)
    );

    const completed = new Set<number>();

    while (completed.size < jobs.length) {
      const pending = jobs
        .map((p, i) => ({ promise: p, index: i }))
        .filter(({ index }) => !completed.has(index));
      
      const winner = await Promise.race(
        pending.map(({ promise, index }) => 
          promise.then(() => index)
        )
      );
      
      completed.add(winner);
      const snapshot = container.getResults(limit);
      if (snapshot.length > 0) yield snapshot;
    }
  }

  private toResponse(
    query: string,
    results: SearchResult[],
    durationMs: number
  ): SearchResponse {
    const srcNames = [...new Set(results.flatMap((r) => r.sources))] as SourceName[];
    return { query, results, count: results.length, sources: srcNames, durationMs };
  }

  private initEngines(): Map<SourceName, Engine> {
    const { newsRegion = DEFAULT_REGION, braveApiKey, tavilyApiKey, googleApiKey, googleCx } = this.config;
    const m = new Map<SourceName, Engine>();

    m.set("duckduckgo", new DuckDuckGoEngine(this.logger));
    m.set("bing",       new BingEngine(newsRegion));
    m.set("mojeek",     new MojeekEngine());
    m.set("googlenews", new GoogleNewsEngine(newsRegion));
    m.set("bingnews",   new BingNewsEngine(newsRegion));
    m.set("wikipedia",  new WikipediaEngine());
    m.set("openalex",   new OpenAlexEngine());
    m.set("marginalia", new MarginaliaEngine());
    m.set("yep",        new YepEngine());
    m.set("indiacode",  new IndiaCodeEngine());
    m.set("sebi",       new SebiEngine());

    if (tavilyApiKey)              m.set("tavily",    new TavilyEngine(tavilyApiKey));
    if (braveApiKey)               m.set("brave",     new BraveEngine(braveApiKey));
    else                           m.set("brave",     new BraveFreeEngine());
    if (googleApiKey && googleCx)  m.set("google",    new GoogleEngine(googleApiKey, googleCx));
    m.set("searxng", new SearXNGEngine(this.config.searxng ?? {}));

    return m;
  }

  private buildEntries(requested?: SourceName[], scopedDomains?: string[]): EngineEntry[] {
    const DEFAULT_EXCLUDED: SourceName[] = ["openalex", "indiacode", "sebi"];
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
      searxng:    "primary",
      marginalia: "primary",
      yep:        "primary",
      openmeteo:  "primary",
      indiacode:  "primary",
      sebi:       "primary",
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

    const scopedEntries: EngineEntry[] = [];
    if (scopedDomains && scopedDomains.length > 0 && !requested) {
      const freeWeb: SourceName[] = ["duckduckgo", "bing", "mojeek", "brave"];
      for (const entry of base) {
        if (freeWeb.includes(entry.engine.name as SourceName)) {
          scopedEntries.push({ engine: entry.engine, variant: "scoped" });
        }
      }
    }

    return [...base, ...pluginEntries, ...scopedEntries];
  }
}
