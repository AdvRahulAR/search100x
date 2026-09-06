import { IResultCache, DEFAULT_TTL_MS } from "./cache.js";
import { SearchResult } from "./types.js";

// node:sqlite is available natively in Node.js 22+.
// Type declaration avoids hard dependency on @types/node >= 22.
interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

/**
 * Persistent SQLite Result Cache using Node.js native node:sqlite.
 * Zero external dependencies, fast embedded storage.
 */
export class SqliteResultCache implements IResultCache {
  private db?: DatabaseSyncInstance;
  private readonly ttlMs: number;
  private fallbackStore = new Map<string, { results: SearchResult[]; expiresAt: number; query?: string }>();

  constructor(dbPath = ":memory:", ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    try {
      const sqliteModule = (globalThis as unknown as { process?: { getBuiltinModule?: (m: string) => unknown } })
        .process?.getBuiltinModule?.("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncInstance } | undefined;
      
      if (sqliteModule?.DatabaseSync) {
        this.db = new sqliteModule.DatabaseSync(dbPath);
        this.init();
      }
    } catch {
      // node:sqlite requires --experimental-sqlite in Node <23. Uses memory store fallback.
    }
  }

  private init(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        query TEXT,
        results_json TEXT,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_search_expires ON search_cache(expires_at);
    `);
  }

  get(key: string): SearchResult[] | undefined {
    const now = Date.now();
    if (!this.db) {
      const entry = this.fallbackStore.get(key);
      if (!entry) return undefined;
      if (now > entry.expiresAt) {
        this.fallbackStore.delete(key);
        return undefined;
      }
      return entry.results;
    }

    const stmt = this.db.prepare("SELECT results_json, expires_at FROM search_cache WHERE key = ?");
    const row = stmt.get(key) as { results_json: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (now > row.expires_at) {
      this.db.prepare("DELETE FROM search_cache WHERE key = ?").run(key);
      return undefined;
    }
    try {
      return JSON.parse(row.results_json) as SearchResult[];
    } catch {
      return undefined;
    }
  }

  set(key: string, results: SearchResult[], query?: string): void {
    const expiresAt = Date.now() + this.ttlMs;
    if (!this.db) {
      this.fallbackStore.set(key, { results, expiresAt, query });
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO search_cache (key, query, results_json, expires_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(key, query ?? "", JSON.stringify(results), expiresAt);
  }

  evict(): void {
    const now = Date.now();
    if (!this.db) {
      for (const [k, v] of this.fallbackStore.entries()) {
        if (now > v.expiresAt) this.fallbackStore.delete(k);
      }
      return;
    }
    this.db.prepare("DELETE FROM search_cache WHERE expires_at < ?").run(now);
  }

  close(): void {
    if (this.db) {
      this.db.close();
    } else {
      this.fallbackStore.clear();
    }
  }
}
