import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { SearchResult } from "./types.js";

export interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
  query?: string;
  sources?: string[];
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_MAX_ENTRIES = 500;

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

/**
 * Canonical, order-insensitive form of a query. Unicode-aware (Hindi, Tamil,
 * etc. are preserved), keeps every number, drops only English stop-words and
 * punctuation. Two queries share a fingerprint only if they contain the same
 * content words — "rbi repo rate" and "rbi repo rate 2024" do NOT.
 */
export function queryFingerprint(query: string): string {
  const normalised = query.normalize("NFKC").toLowerCase();
  const tokens = normalised
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOP.has(t))
    .map(t => (/^[a-z]+$/.test(t) && t.length > 3 ? stem(t) : t))
    .sort();

  // All-stop-word queries fall back to the whitespace-normalised raw query.
  const canonical = tokens.length > 0
    ? [...new Set(tokens)].join("|")
    : normalised.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

// ── Common interface ──────────────────────────────────────────────────────────

export interface IResultCache {
  get(key: string, query?: string, sources?: string[]): SearchResult[] | undefined;
  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void;
  evict(): void;
}

// ── Shared key builder ────────────────────────────────────────────────────────

/**
 * Build a cache key. `options` must include every parameter that can change
 * the returned results (page, time range, preset, domains, limit, enrichment,
 * reranking…). Values are serialised with sorted keys so order doesn't matter.
 */
export function cacheKey(query: string, sources: string[], options: Record<string, unknown> = {}): string {
  const fingerprint = queryFingerprint(query);
  const opts = Object.keys(options)
    .filter((k) => options[k] !== undefined)
    .sort()
    .map((k) => {
      const v = options[k];
      return `${k}=${JSON.stringify(Array.isArray(v) ? [...v].map(String).sort() : v)}`;
    })
    .join("&");
  const canonical = fingerprint + "|" + [...sources].sort().join(",") + "|" + opts;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Revive Date fields after JSON round-trips. */
function reviveDates(results: SearchResult[]): SearchResult[] {
  for (const r of results as any[]) {
    for (const f of ["publishedAt", "fetchedAt"]) {
      if (typeof r?.[f] === "string") {
        const d = new Date(r[f]);
        if (!isNaN(d.getTime())) r[f] = d;
      }
    }
  }
  return results;
}

// ── In-memory cache (default) ─────────────────────────────────────────────────

/**
 * Bounded LRU cache with TTL. Lookups are exact-key only: the key already
 * encodes the canonical query and every output-affecting option, so a hit is
 * always the answer to the same request.
 */
export class ResultCache implements IResultCache {
  private store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** @deprecated Use top-level cacheKey() */
  static key(query: string, sources: string[]): string {
    return cacheKey(query, sources);
  }

  get(key: string): SearchResult[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.results;
  }

  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void {
    this.store.delete(key);
    this.store.set(key, { results, expiresAt: Date.now() + this.ttlMs, query, sources });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
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
  private entries = new Map<string, CacheEntry>();
  private loaded = false;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly filePath: string,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, maxEntries);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, CacheEntry>;
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.expiresAt === "number" && v.expiresAt > now && Array.isArray(v.results)) {
          v.results = reviveDates(v.results);
          this.entries.set(k, v);
        }
      }
      this.trim();
    } catch {
      // file doesn't exist yet or is corrupt — start empty
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private flush(): void {
    const data: Record<string, CacheEntry> = {};
    for (const [k, v] of this.entries) data[k] = v;
    // Atomic replace: write to a temp file then rename, so a crash mid-write
    // never leaves a truncated cache file behind.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn("[FileResultCache] failed to write cache file:", (err as Error).message);
    }
  }

  get(key: string): SearchResult[] | undefined {
    this.load();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[], query?: string, sources?: string[]): void {
    this.load();
    this.entries.delete(key);
    this.entries.set(key, { results, expiresAt: Date.now() + this.ttlMs, query, sources });
    this.trim();
    this.flush();
  }

  evict(): void {
    this.load();
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (now > v.expiresAt) this.entries.delete(k);
    }
    this.flush();
  }
}
