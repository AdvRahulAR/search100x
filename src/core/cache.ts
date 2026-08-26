import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SearchResult } from "./types.js";

export interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
  query?: string;
  sources?: string[];
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const STOP = new Set(["what","are","the","is","a","an","of","in","for","how","do","does","to","and","or"]);

export function stem(w: string): string {
  return w
    .replace(/ing$/, "").replace(/tion$/, "").replace(/tions$/, "")
    .replace(/ment$/, "").replace(/ments$/, "").replace(/ness$/, "")
    .replace(/ies$/, "y").replace(/es$/, "").replace(/s$/, "")
    .replace(/ed$/, "");
}

function fnv1a(str: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h;
}

export function simhash(query: string): bigint {
  const tokens = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t))
    .sort();

  let fp = 0n;
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx1 = Number(h % 64n);
    const idx2 = Number((h >> 6n) % 64n);
    fp |= (1n << BigInt(idx1));
    fp |= (1n << BigInt(idx2));
  }
  return fp;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b, d = 0;
  while (x) { x &= x - 1n; d++; }   // Kernighan's bit-count
  return d;
}

export function queryFingerprint(query: string): string {
  const tokens = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t))
    .map(stem)
    .sort();

  const canonical = [...new Set(tokens)].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

// ── Common interface ──────────────────────────────────────────────────────────

export interface IResultCache {
  get(key: string, query?: string, sources?: string[]): SearchResult[] | undefined;
  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void;
  evict(): void;
}

// ── Shared key builder ────────────────────────────────────────────────────────

export function cacheKey(query: string, sources: string[]): string {
  const fingerprint = queryFingerprint(query);
  const canonical = fingerprint + "|" + [...sources].sort().join(",");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ── In-memory cache (default) ─────────────────────────────────────────────────

export class ResultCache implements IResultCache {
  private store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** @deprecated Use top-level cacheKey() */
  static key(query: string, sources: string[]): string {
    return cacheKey(query, sources);
  }

  get(key: string, query?: string, sources?: string[]): SearchResult[] | undefined {
    // 1. Fast path: exact matching key
    const entry = this.store.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return undefined;
      }
      return entry.results;
    }

    // 2. Soft path: SimHash matching
    if (query && sources) {
      const querySig = simhash(query);
      const sourcesSorted = [...sources].sort().join(",");
      for (const [k, e] of this.store.entries()) {
        if (Date.now() > e.expiresAt) {
          this.store.delete(k);
          continue;
        }
        if (e.query && e.sources) {
          const eSourcesSorted = [...e.sources].sort().join(",");
          if (sourcesSorted !== eSourcesSorted) continue;

          const eSig = simhash(e.query);
          if (hammingDistance(querySig, eSig) <= 3) {
            return e.results;
          }
        }
      }
    }

    return undefined;
  }

  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void {
    this.store.set(key, { results, expiresAt: Date.now() + this.ttlMs, query, sources });
  }

  evict(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now > v.expiresAt) this.store.delete(k);
    }
  }

  get size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
}

// ── File-backed cache (optional, survives restarts) ───────────────────────────

export class FileResultCache implements IResultCache {
  private memory = new Map<string, CacheEntry>();
  private loaded = false;
  private readonly ttlMs: number;

  constructor(
    private readonly filePath: string,
    ttlMs = DEFAULT_TTL_MS
  ) {
    this.ttlMs = ttlMs;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(data)) {
        this.memory.set(k, v);
      }
    } catch {
      // file doesn't exist yet — start empty
    }
  }

  private flush(): void {
    const data: Record<string, CacheEntry> = {};
    for (const [k, v] of this.memory) data[k] = v;
    try {
      writeFileSync(this.filePath, JSON.stringify(data));
    } catch (err) {
      console.warn("[FileResultCache] failed to write cache file:", (err as Error).message);
    }
  }

  get(key: string, query?: string, sources?: string[]): SearchResult[] | undefined {
    this.load();
    const entry = this.memory.get(key);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.memory.delete(key);
        return undefined;
      }
      return entry.results;
    }

    if (query && sources) {
      const querySig = simhash(query);
      const sourcesSorted = [...sources].sort().join(",");
      for (const [k, e] of this.memory.entries()) {
        if (Date.now() > e.expiresAt) {
          this.memory.delete(k);
          continue;
        }
        if (e.query && e.sources) {
          const eSourcesSorted = [...e.sources].sort().join(",");
          if (sourcesSorted !== eSourcesSorted) continue;

          const eSig = simhash(e.query);
          if (hammingDistance(querySig, eSig) <= 3) {
            return e.results;
          }
        }
      }
    }

    return undefined;
  }

  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void {
    this.load();
    this.memory.set(key, { results, expiresAt: Date.now() + this.ttlMs, query, sources });
    this.flush();
  }

  evict(): void {
    this.load();
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (now > v.expiresAt) this.memory.delete(k);
    }
    this.flush();
  }
}
