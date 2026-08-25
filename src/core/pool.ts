/**
 * Connection pool + concurrency limiter + request deduplication.
 *
 * Phase 1: Speed Infrastructure
 * ──────────────────────────────
 * Limits concurrent HTTP fetches to avoid overwhelming the event loop,
 * deduplicates in-flight requests for the same URL, and provides a
 * simple Map-based DNS cache to skip repeated resolve() calls.
 *
 * Zero dependencies — uses native fetch with AbortController.
 */

interface InFlight<T> {
  promise: Promise<T>;
  timestamp: number;
}

export class ConnectionPool {
  private inflight = new Map<string, InFlight<unknown>>();
  private dnsCache = new Map<string, string>();
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly dnsTtlMs: number;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent = 8, dnsTtlMs = 300_000) {
    this.maxConcurrent = maxConcurrent;
    this.dnsTtlMs = dnsTtlMs;
  }

  /** Acquire a concurrency slot. Returns a release function. */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Deduplicated fetch — if the same URL is already being fetched,
   * returns the existing promise instead of making a new request.
   */
  async dedupFetch<T>(
    url: string,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const cached = this.inflight.get(url);
    if (cached && Date.now() - cached.timestamp < 10_000) {
      return cached.promise as Promise<T>;
    }

    const promise = (async () => {
      const release = await this.acquire();
      try {
        return await fetcher();
      } finally {
        release();
        // Clean up after a short delay to allow concurrent dedup
        setTimeout(() => this.inflight.delete(url), 100);
      }
    })();

    this.inflight.set(url, { promise, timestamp: Date.now() });
    return promise;
  }

  /** DNS cache — avoids repeated hostname lookups for the same domain. */
  getCachedIp(hostname: string): string | undefined {
    const entry = this.dnsCache.get(hostname);
    if (!entry) return undefined;
    return entry;
  }

  setCachedIp(hostname: string, ip: string): void {
    this.dnsCache.set(hostname, ip);
    setTimeout(() => this.dnsCache.delete(hostname), this.dnsTtlMs);
  }

  get stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      inflight: this.inflight.size,
      dnsCached: this.dnsCache.size,
    };
  }
}

/** Global singleton pool — shared across all engines and enrichment fetches. */
export const globalPool = new ConnectionPool(8);

/**
 * Concurrency-limited map — runs async mapper with at most `limit` concurrent.
 * Returns results in the same order as the input array.
 */
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  limit = 4
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
