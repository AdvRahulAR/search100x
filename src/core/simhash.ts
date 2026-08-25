/**
 * SimHash near-duplicate detection for search results.
 *
 * Phase 4: Intelligence
 * ────────────────────
 * 64-bit SimHash fingerprint computed from result title + snippet + URL.
 * Results with Hamming distance ≤ 3 from a higher-ranked result are demoted.
 *
 * Also implements a lightweight TF-IDF vector-based semantic cache that
 * detects near-duplicate queries without any ML runtime — pure JS.
 */

// ── SimHash for content dedup ────────────────────────────────────────────────

const FNV_PRIME = 0x100000001b3n;
const FNV_OFFSET = 0xcbf29ce484222325n;

function fnv1a64(str: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return h;
}

function tokenize3(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Compute a 64-bit SimHash fingerprint for a text string.
 */
export function contentSimhash(text: string): bigint {
  const tokens = tokenize3(text);
  if (tokens.length === 0) return 0n;

  const v = new Int8Array(64);
  for (const tok of tokens) {
    const h = fnv1a64(tok);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      v[i] += bit ? 1 : -1;
    }
  }

  let fp = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) fp |= (1n << BigInt(i));
  }
  return fp;
}

export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let d = 0;
  while (x) { x &= x - 1n; d++; }
  return d;
}

export interface DedupResult<T> {
  result: T;
  fingerprint: bigint;
  isDuplicate: boolean;
  duplicateOf?: number;
}

/**
 * Deduplicate search results by content similarity.
 * Results with Hamming distance ≤ threshold from a higher-ranked result are marked as duplicates.
 *
 * @returns Array with isDuplicate flags set; caller decides whether to filter or demote.
 */
export function dedupByContent<T extends { title: string; snippet: string; url: string }>(
  results: T[],
  threshold = 3
): DedupResult<T>[] {
  const fingerprints = results.map((r) =>
    contentSimhash(r.title + " " + r.snippet + " " + r.url)
  );

  return results.map((r, i) => {
    for (let j = 0; j < i; j++) {
      if (hamming64(fingerprints[i], fingerprints[j]) <= threshold) {
        return { result: r, fingerprint: fingerprints[i], isDuplicate: true, duplicateOf: j };
      }
    }
    return { result: r, fingerprint: fingerprints[i], isDuplicate: false };
  });
}

// ── TF-IDF Semantic Cache ───────────────────────────────────────────────────

/**
 * Lightweight semantic cache using TF-IDF cosine similarity.
 * No ML runtime needed — just vector math on query tokens.
 *
 * For evergreen queries (legal, academic, general knowledge),
 * the cache hit rate should exceed 30%.
 */

const STOPWORDS = new Set([
  "what", "is", "the", "a", "an", "of", "in", "for", "how", "to", "and", "or",
  "are", "was", "were", "been", "be", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "can", "this", "that",
  "these", "those", "it", "its", "as", "at", "by", "on", "from", "with", "about",
]);

function stemSimple(w: string): string {
  return w
    .replace(/(ing|tion|tions|ment|ments|ness|ies|es|s|ed)$/g, "")
    .slice(0, 20);
}

interface SemanticCacheEntry<T> {
  query: string;
  vector: Map<string, number>;
  results: T;
  timestamp: number;
  freshnessTtl: number;
}

export class SemanticCache<T> {
  private entries: SemanticCacheEntry<T>[] = [];
  private documentFreq = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly similarityThreshold: number;

  constructor(maxEntries = 500, similarityThreshold = 0.85) {
    this.maxEntries = maxEntries;
    this.similarityThreshold = similarityThreshold;
  }

  /** Compute TF-IDF vector for a query string. */
  private vectorize(query: string): Map<string, number> {
    const tokens = tokenize3(query)
      .filter((t) => !STOPWORDS.has(t))
      .map(stemSimple);

    const tf = new Map<string, number>();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }

    const N = this.entries.length + 1;
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const df = this.documentFreq.get(term) ?? 0;
      const idf = Math.log(N / (df + 1)) + 1;
      vec.set(term, count * idf);
    }
    return vec;
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0, magA = 0, magB = 0;
    for (const [k, v] of a) {
      const bv = b.get(k);
      if (bv !== undefined) {
        dot += v * bv;
      }
      magA += v * v;
    }
    for (const v of b.values()) {
      magB += v * v;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  /**
   * Look up a query in the semantic cache.
   * Returns cached results if similarity ≥ threshold and entry hasn't expired.
   */
  get(query: string, freshnessTtl = 30 * 60 * 1000): T | undefined {
    const queryVec = this.vectorize(query);
    let bestMatch: SemanticCacheEntry<T> | undefined;
    let bestScore = 0;

    for (const entry of this.entries) {
      if (Date.now() - entry.timestamp > entry.freshnessTtl) continue;
      const score = this.cosineSimilarity(queryVec, entry.vector);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestScore >= this.similarityThreshold) {
      return bestMatch.results;
    }
    return undefined;
  }

  /** Add a query + results to the semantic cache. */
  set(query: string, results: T, freshnessTtl = 30 * 60 * 1000): void {
    const vector = this.vectorize(query);

    // Update document frequencies
    for (const term of vector.keys()) {
      this.documentFreq.set(term, (this.documentFreq.get(term) ?? 0) + 1);
    }

    this.entries.push({ query, vector, results, timestamp: Date.now(), freshnessTtl });

    // Evict oldest if over capacity
    if (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift()!;
      for (const term of removed.vector.keys()) {
        const df = this.documentFreq.get(term);
        if (df && df > 1) {
          this.documentFreq.set(term, df - 1);
        } else {
          this.documentFreq.delete(term);
        }
      }
    }
  }

  /** Get cache stats. */
  get stats() {
    return {
      entries: this.entries.length,
      hitRate: this.hits / Math.max(this.lookups, 1),
    };
  }

  private hits = 0;
  private lookups = 0;

  /** Track a cache lookup (for hit rate calculation). */
  trackLookup(hit: boolean): void {
    this.lookups++;
    if (hit) this.hits++;
  }

  clear(): void {
    this.entries = [];
    this.documentFreq.clear();
  }
}

// ── Freshness-aware cache invalidation ────────────────────────────────────────

/**
 * Determine cache TTL based on query type.
 * - News: short TTL (5 min) — content changes frequently
 * - Legal/academic: long TTL (24 hours) — evergreen content
 * - General: medium TTL (30 min)
 */
export function freshnessTtl(queryType: string): number {
  switch (queryType) {
    case "news": return 5 * 60 * 1000;
    case "legal": return 24 * 60 * 60 * 1000;
    case "academic": return 12 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

/**
 * Check if a cached result should be invalidated based on freshness.
 * Results with publishedAt dates within the timeRange window are still fresh.
 */
export function isCacheFresh(
  cachedAt: number,
  ttl: number,
  publishedAt?: Date,
  timeRange?: string
): boolean {
  const age = Date.now() - cachedAt;
  if (age > ttl) return false;

  // For news with timeRange, check if results are still within the window
  if (publishedAt && timeRange) {
    const ageHours = (Date.now() - publishedAt.getTime()) / 3_600_000;
    switch (timeRange) {
      case "day": return ageHours < 24;
      case "week": return ageHours < 168;
      case "month": return ageHours < 720;
    }
  }

  return true;
}
