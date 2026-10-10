import {
  SearchConfig, SearchOptions, SearchResponse, SearchResult, SourceName, Logger, EngineStatus,
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
import { setCustomDomainBoosts } from "./core/reputation.js";

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
import { SearXNGEngine, resolveSearXNGConfig } from "./adapters/searxng.js";
import { configureProxy } from "./core/proxy.js";
import { MarginaliaEngine } from "./adapters/marginalia.js";
import { YepEngine }        from "./adapters/yep.js";
import { OpenMeteoEngine }  from "./adapters/openmeteo.js";
import { IndiaCodeEngine, SebiEngine } from "./adapters/indiacode.js";
import { IndianKanoonEngine } from "./adapters/indiankanoon.js";
import { StartpageEngine } from "./adapters/startpage.js";
import { DuckDuckGoLiteEngine } from "./adapters/enhanced-engines.js";
import { HackerNewsEngine } from "./adapters/hackernews.js";
import { GitHubEngine } from "./adapters/github.js";
import { ArXivEngine } from "./adapters/arxiv.js";

export { DOMAIN_PRESETS, DOMAIN_CATEGORIES, getCategoryDomains, listDomainCategories, listDomainPresets, resolvePresetDomains } from "./core/transformer.js";
export { ResultCache, FileResultCache } from "./core/cache.js";

const DEFAULT_TIMEOUT = 7000;
const DEFAULT_LIMIT   = 15;
const DEFAULT_REGION  = "US";

type QueryVariant = keyof Pick<QueryBundle, "primary" | "recent" | "scoped">;

interface EngineEntry {
  engine:  Engine;
  variant: QueryVariant;
  /** For scoped entries: which site:-clause chunk of the scoped domains to use. */
  scopeChunk?: number;
}

function entryQuery(bundle: QueryBundle, entry: EngineEntry): string {
  if (entry.scopeChunk !== undefined && bundle.scopedChunks.length > 0) {
    return bundle.scopedChunks[entry.scopeChunk % bundle.scopedChunks.length];
  }
  return bundle[entry.variant];
}

/** Call an engine so that synchronous throws become rejections (never unhandled). */
function invoke<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  label: string,
  logger?: Logger,
  onError?: (message: string) => void
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger?.warn(`[search100x] ${label} timed out after ${Math.round(remainingMs)}ms`);
      onError?.(`timed out after ${Math.round(remainingMs)}ms`);
      resolve(null);
    }, remainingMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); })
           .catch((err) => {
             clearTimeout(timer);
             onError?.(errorMessage(err));
             resolve(null);
           });
  });
}

/** True when `url`'s host equals or is a subdomain of one of `domains` (paths in domains are ignored). */
export function urlInScope(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return false;
  }
  return domains.some((raw) => {
    const d = raw.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/\.$/, "");
    return d.length > 0 && (host === d || host.endsWith("." + d));
  });
}

function validateLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`search100x: limit must be an integer between 1 and 100, got ${String(limit)}`);
  }
  return limit;
}

/** Max domains per site: clause (engines truncate very long OR chains). */
const SCOPE_CHUNK_SIZE = 6;
/** Max number of scoped query chunks (=> up to 30 domains queried). */
const MAX_SCOPE_CHUNKS = 5;

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
    if (config.proxy !== undefined || config.noProxy !== undefined) {
      // Process-wide: every adapter shares one HTTP layer.
      configureProxy({ url: config.proxy, noProxy: config.noProxy });
    }
    if (config.customDomainBoosts) {
      setCustomDomainBoosts(config.customDomainBoosts);
    }
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

    validateLimit(limit);

    const autoClass  = classifyQuery(query);
    const preset     = scoringPreset
      ?? (autoClass.confidence > 0.65 ? autoClass.category : "default");

    const resolvedTimeRange = timeRange ?? (preset === "news" ? "week" : undefined);

    const totalTimeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline     = Date.now() + totalTimeout;
    const entries      = this.buildEntries(options.sources, scopedDomains, preset);
    const srcKeys      = entries.map((e) => `${e.engine.name}:${e.variant}`);

    // Every option that can change the output is part of the key.
    const cacheKeyStr = cacheKey(query, srcKeys, {
      timeRange: resolvedTimeRange,
      page,
      preset,
      limit,
      scopedDomains,
      scopeMode: scopedDomains?.length ? (options.scopeMode ?? "strict") : undefined,
      enrichTopN,
      enrichContent,
      rerank,
      rerankCandidates: rerank ? rerankCandidates : undefined,
      reformulate: options.reformulate,
      deep: options.deep,
      browser: !!(options.browser ?? this.config.browser)?.enabled,
    });

    if (!noCache) {
      const cached = this.cache.get(cacheKeyStr, query, srcKeys);
      if (cached) return { ...this.toResponse(query, cached.slice(0, limit), Date.now() - (deadline - totalTimeout)), cached: true };
    }

    const bundle    = buildQueryBundle(query, scopedDomains, resolvedTimeRange, page);
    const weights   = SCORING_PRESETS[preset] ?? DEFAULT_WEIGHTS;
    const halfLife  = preset === "legal" || preset === "academic" ? 365 : (preset === "news" ? 3 : (preset === "business" ? 14 : (preset === "tech" ? 90 : 30)));
    const container = new ResultContainer(query);

    const liveIntent = detectLiveIntent(query);
    let activeEntries = entries;

    const tasks: Promise<void>[] = [];

    let pinnedResult: SearchResult | null = null;

    if (liveIntent === "weather") {
      const weatherEngine = new OpenMeteoEngine();
      const weatherTimeout = ENGINE_TIMEOUTS["openmeteo"] ?? 6_000;
      const weatherResult = await withDeadline(
        invoke(() => weatherEngine.search(query, weatherTimeout)),
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

    const minResults = options.minResults ?? 5;
    const minEngines = options.minEngines ?? 3;
    const maxWaitMs = options.maxWaitMs ?? 4000;
    const noEarlyReturn = options.noEarlyReturn ?? false;
    const isDeep = options.deep ?? false;

    let successfulEngines = 0;
    let settled = false;
    const engineStatus: Record<string, EngineStatus> = {};

    const executeEngines = async (): Promise<void> => {
      return new Promise<void>((resolve) => {
        let pending = activeEntries.length;

        const checkEarlyReturn = () => {
          if (settled) return;
          if (!noEarlyReturn && !isDeep) {
            if (container.size >= minResults && successfulEngines >= minEngines) {
              settled = true;
              resolve();
            }
          }
        };

        const timeoutTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, Math.min(totalTimeout, isDeep ? totalTimeout : maxWaitMs));

        if (activeEntries.length === 0) {
          clearTimeout(timeoutTimer);
          resolve();
          return;
        }

        activeEntries.forEach((entry) => {
          const { engine } = entry;
          const statusKey = entry.scopeChunk !== undefined ? `${engine.name}:scoped${entry.scopeChunk}` : engine.name;
          (async () => {
            const started = Date.now();
            const engineErrors: string[] = [];
            try {
              if (this.circuit.isOpen(engine.name)) {
                this.logger.warn(`[circuit] skipping ${engine.name} (OPEN)`);
                engineStatus[statusKey] = { ok: false, ms: 0, count: 0, skipped: "circuit-open" };
                return;
              }

              const engineTimeout = ENGINE_TIMEOUTS[engine.name] ?? totalTimeout;
              const remaining = Math.max(1_000, Math.min(engineTimeout, deadline - Date.now()));
              const result = await withDeadline(
                invoke(() => engine.search(entryQuery(bundle, entry), remaining, bundle.timeRange, bundle.page)),
                remaining,
                engine.name,
                this.logger,
                (msg) => { engineErrors.push(msg); }
              );

              let effectiveResult = result;
              // If duckduckgo fails or returns 0 (CAPTCHA/bot-block), fall back to DuckDuckGo Lite.
              if ((effectiveResult === null || effectiveResult.length === 0) && engine.name === "duckduckgo") {
                const fallbackTimeout = Math.min(3000, Math.max(1000, deadline - Date.now()));
                const liteRes = await withDeadline(
                  invoke(() => new DuckDuckGoLiteEngine().search(entryQuery(bundle, entry), fallbackTimeout)),
                  fallbackTimeout,
                  "duckduckgo-lite",
                  this.logger
                );
                if (liteRes && liteRes.length > 0) effectiveResult = liteRes;
              }

              if (effectiveResult === null) {
                this.circuit.recordFailure(engine.name);
              } else if (effectiveResult.length > 0) {
                container.add(engine.name, effectiveResult);
                this.circuit.recordSuccess(engine.name);
                successfulEngines++;
              }
              engineStatus[statusKey] = {
                ok:    effectiveResult !== null,
                ms:    Date.now() - started,
                count: effectiveResult?.length ?? 0,
                ...(effectiveResult === null && engineErrors.length > 0 ? { error: engineErrors[0] } : {}),
              };
              checkEarlyReturn();
            } catch (err) {
              // Defensive: nothing above should throw, but never leave `pending` stuck.
              engineStatus[statusKey] = { ok: false, ms: Date.now() - started, count: 0, error: errorMessage(err) };
            } finally {
              pending--;
              if (pending === 0 && !settled) {
                clearTimeout(timeoutTimer);
                settled = true;
                resolve();
              }
            }
          })();
        });
      });
    };

    await executeEngines();

    const shouldReformulate = options.reformulate ?? false;
    const extraQueries = shouldReformulate ? reformulateQuery(query).slice(1) : [];

    if (extraQueries.length > 0) {
      const extraTasks: Promise<void>[] = [];
      extraQueries.forEach((eq) => {
        const eqBundle = buildQueryBundle(eq, scopedDomains, resolvedTimeRange, page);
        const freeWebEngines = ["duckduckgo", "bing", "mojeek", "brave", "searxng"];
        const activeFreeEntries = entries.filter(e => freeWebEngines.includes(e.engine.name));

        activeFreeEntries.forEach(({ engine, variant }) => {
          extraTasks.push((async () => {
            if (this.circuit.isOpen(engine.name)) return;
            const engineTimeout = ENGINE_TIMEOUTS[engine.name] ?? totalTimeout;
            const remaining     = Math.max(1_000, Math.min(engineTimeout, deadline - Date.now()));
            const result        = await withDeadline(
              invoke(() => engine.search(eqBundle[variant], remaining, eqBundle.timeRange, eqBundle.page)),
              remaining,
              `${engine.name}:${eq}`,
              this.logger
            );
            if (result === null) {
              this.circuit.recordFailure(engine.name);
            } else if (result.length > 0) {
              container.add(engine.name, result);
              this.circuit.recordSuccess(engine.name);
            }
          })());
        });
      });
      await Promise.all(extraTasks);
    }

    const fetchLimit = rerank ? Math.max(limit, rerankCandidates) : limit;
    const strictScope = !!scopedDomains?.length && (options.scopeMode ?? "strict") === "strict";
    let results = strictScope
      // Rank a wider pool, then keep only in-scope results.
      ? container.getResults(100, weights, halfLife)
          .filter((r) => urlInScope(r.url, scopedDomains!))
          .slice(0, fetchLimit)
      : container.getResults(fetchLimit, weights, halfLife);

    if (pinnedResult) {
      results = [pinnedResult, ...results.filter(r => r.url !== pinnedResult!.url)];
    }

    const browserConfig = options.browser ?? this.config.browser;

    if (enrichTopN > 0 && results.length > 0) {
      results = await enrichSnippets(results, enrichTopN, Math.min(totalTimeout, 5_000), query, browserConfig);
    }

    if (enrichContent > 0 && results.length > 0) {
      // Auto-detect legal queries and use legal mode: 500-word windows,
      // 12000-char cap, jurisdiction-aware BM25 boost, citation-aware scoring
      const isLegal = preset === "legal";
      const enrichTimeout = Math.min(totalTimeout, isLegal ? 8_000 : 8_000);
      results = await enrichContents(results, enrichContent, enrichTimeout, query, { legalMode: isLegal, browser: browserConfig });
    }

    if (rerank && results.length > 0) {
      results = await rerankResults(query, results, rerankCandidates);
    }

    results = results.slice(0, limit);

    if (!noCache) {
      this.cache.set(cacheKeyStr, results, query, srcKeys);
    }

    return { ...this.toResponse(query, results, Date.now() - (deadline - totalTimeout)), engines: engineStatus };
  }

  async *searchStream(
    query:   string,
    options: SearchOptions = {}
  ): AsyncGenerator<SearchResult[]> {
    const { limit = DEFAULT_LIMIT, scopedDomains, timeRange, page = 1 } = options;
    validateLimit(limit);
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
            invoke(() => engine.search(bundle[variant], remaining, bundle.timeRange, bundle.page)),
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
    m.set("indiankanoon", new IndianKanoonEngine());
    m.set("startpage",  new StartpageEngine());
    m.set("hackernews", new HackerNewsEngine());
    m.set("github",     new GitHubEngine());
    m.set("arxiv",      new ArXivEngine());

    if (tavilyApiKey)              m.set("tavily",    new TavilyEngine(tavilyApiKey));
    if (braveApiKey)               m.set("brave",     new BraveEngine(braveApiKey));
    else                           m.set("brave",     new BraveFreeEngine());
    if (googleApiKey && googleCx)  m.set("google",    new GoogleEngine(googleApiKey, googleCx));
    // SearXNG is opt-in: only registered when a baseUrl is configured (or SEARXNG_URL is set).
    const searxngCfg = resolveSearXNGConfig(this.config.searxng ?? {});
    if (searxngCfg) m.set("searxng", new SearXNGEngine(searxngCfg));

    return m;
  }

  private buildEntries(requested?: SourceName[], scopedDomains?: string[], preset?: string): EngineEntry[] {
    const isLegalPreset = preset === "legal" || (scopedDomains && scopedDomains.some(d => d.includes(".nic.in") || d.includes("kanoon") || d.includes("livelaw")));
    const isAcademic = preset === "academic";
    const isTech = preset === "tech";
    const isBusiness = preset === "business";
    const DEFAULT_EXCLUDED: SourceName[] = isLegalPreset
      ? ["openalex", "arxiv", "github"]
      : isAcademic
      ? ["indiacode", "sebi", "github"]
      : isTech
      ? ["openalex", "indiacode", "sebi", "arxiv"]
      : isBusiness
      ? ["openalex", "arxiv", "indiacode"]
      : ["openalex", "arxiv", "indiacode", "sebi"];
    const VARIANT: Record<SourceName, QueryVariant> = {
      duckduckgo:   "primary",
      startpage:    "primary",
      bing:         "primary",
      mojeek:       "primary",
      googlenews:   "recent",
      bingnews:     "primary",
      wikipedia:    "primary",
      openalex:     "primary",
      tavily:       "primary",
      brave:        "scoped",
      google:       "primary",
      searxng:      "primary",
      marginalia:   "primary",
      yep:          "primary",
      openmeteo:    "primary",
      indiacode:    "primary",
      sebi:         "primary",
      indiankanoon: "primary",
      hackernews:   "primary",
      github:       "primary",
      arxiv:        "primary",
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
      const freeWeb = ["duckduckgo", "bing", "mojeek", "brave"];
      const scopedEngines = base.filter((e) => freeWeb.includes(e.engine.name));
      const nHosts = new Set(scopedDomains.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]).filter(Boolean)).size;
      const nChunks = Math.min(MAX_SCOPE_CHUNKS, Math.max(1, Math.ceil(nHosts / SCOPE_CHUNK_SIZE)));
      if (scopedEngines.length > 0) {
        if (nChunks === 1) {
          for (const e of scopedEngines) scopedEntries.push({ engine: e.engine, variant: "scoped", scopeChunk: 0 });
        } else {
          // Spread chunks over engines: every chunk gets two engines (or all, if fewer).
          const perChunk = Math.min(2, scopedEngines.length);
          for (let c = 0; c < nChunks; c++) {
            for (let k = 0; k < perChunk; k++) {
              const e = scopedEngines[(c + k) % scopedEngines.length];
              scopedEntries.push({ engine: e.engine, variant: "scoped", scopeChunk: c });
            }
          }
        }
      }
    }

    return [...base, ...pluginEntries, ...scopedEntries];
  }
}
