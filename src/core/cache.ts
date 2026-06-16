/**
 * Result cache — two backends, same interface.
 *
 * ResultCache     — in-memory Map, fast, lost on restart (default)
 * FileResultCache — JSON file on disk, survives restarts, zero new deps
 *
 * Pass either to new EnhancedSearch({ cache: ... }).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { SearchResult } from "./types.js";

export interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Common interface ──────────────────────────────────────────────────────────

export interface IResultCache {
  get(key: string): SearchResult[] | undefined;
  set(key: string, results: SearchResult[]): void;
  evict(): void;
}

// ── Shared key builder ────────────────────────────────────────────────────────

export function cacheKey(query: string, sources: string[]): string {
  const canonical = query.trim().toLowerCase() + "|" + [...sources].sort().join(",");
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

  get(key: string): SearchResult[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[]): void {
    this.store.set(key, { results, expiresAt: Date.now() + this.ttlMs });
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

/**
 * Persistent cache that writes to a JSON file using Node's built-in fs.
 * Zero new dependencies.
 *
 * Usage:
 *   const s = new EnhancedSearch({ cache: new FileResultCache("/tmp/search.json") });
 *
 * Write strategy: write-through on every set().  On get() the file is loaded
 * lazily once per process lifetime and then kept in-memory with write-through.
 * Suitable for server and CLI use; not designed for high-concurrency writes.
 */
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

  get(key: string): SearchResult[] | undefined {
    this.load();
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.memory.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: SearchResult[]): void {
    this.load();
    this.memory.set(key, { results, expiresAt: Date.now() + this.ttlMs });
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
