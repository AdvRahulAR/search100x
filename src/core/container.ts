import { RawResult, Appearance, MergedResult, SearchResult, SourceName } from "./types.js";
import { normalizeUrl, urlKey } from "./normalizer.js";
import { engineWeight, rrfScore, normaliseScores } from "./scorer.js";
import { bm25Scores, blendScores } from "./bm25.js";

/**
 * ResultContainer
 * ───────────────
 * Mirrors SearXNG's ResultContainer (results.py) but implemented as a
 * single-pass merge + RRF score computation.
 *
 * Algorithm:
 *  1. For each engine result list (in parallel):
 *       - Normalise the URL → compute hash key
 *       - If key seen: merge (update snippet/title, append appearance)
 *       - If key new:  insert new record
 *  2. After all engines are collected:
 *       - Compute RRF score for every record
 *       - Min-max normalise into [0,1]
 *       - Sort descending by score
 *       - Return top-N
 *
 * Merge rules (from SearXNG's merge_two_main_results):
 *  - title:   keep the one from the higher-weight engine
 *  - snippet: keep the longer of the two
 *  - url:     keep the canonical (first normalised form seen)
 */

interface Record {
  title: string;
  url: string;             // original URL of the first engine that found it
  snippet: string;
  titleEngineWeight: number; // weight of the engine that owns the current title
  appearances: Appearance[];
}

export class ResultContainer {
  private map = new Map<number, Record>();
  private query: string;

  constructor(query = "") {
    this.query = query;
  }

  /**
   * Ingest results from one engine.
   *
   * @param engineName  Source identifier
   * @param results     Ranked list (index 0 = rank 1)
   */
  add(engineName: string, results: RawResult[]): void {
    const weight = engineWeight(engineName);

    results.forEach((raw, index) => {
      if (!raw.url || !raw.title) return;

      const rank = index + 1; // 1-indexed
      const norm = normalizeUrl(raw.url);
      const key = urlKey(norm);
      const appearance: Appearance = { engine: engineName, weight, rank };

      const existing = this.map.get(key);
      if (!existing) {
        this.map.set(key, {
          title: raw.title,
          url: raw.url,
          snippet: raw.snippet,
          titleEngineWeight: weight,
          appearances: [appearance],
        });
        return;
      }

      // Merge — deduplicate appearances so the same (engine, rank) pair from
      // parallel primary+scoped variants doesn't double-count in RRF scoring.
      const isDuplicate = existing.appearances.some(
        (a) => a.engine === engineName && a.rank === rank
      );
      if (!isDuplicate) existing.appearances.push(appearance);

      // Title: prefer higher-weight engine's title
      if (weight > existing.titleEngineWeight) {
        existing.title = raw.title;
        existing.titleEngineWeight = weight;
      }

      // Snippet: prefer longer (more informative)
      if (raw.snippet.length > existing.snippet.length) {
        existing.snippet = raw.snippet;
      }
    });
  }

  /**
   * Finalise: compute scores, normalise, sort, return top-limit results.
   */
  getResults(limit: number): SearchResult[] {
    const records = [...this.map.values()];
    if (records.length === 0) return [];

    // Compute raw RRF scores with cross-engine consensus bonus.
    // Results seen by N engines get a gentle multiplier: ×(1 + 0.08*(N-1))
    // This rewards consensus without overwhelming single-engine quality signal.
    const rawScores  = records.map((r) => {
      const base  = rrfScore(r.appearances);
      // Logarithmic consensus bonus: 2 engines → ×1.10, 4 engines → ×1.17, 8 → ×1.24
      // Logarithm gives diminishing returns — the 4th agreeing engine matters less than the 2nd.
      const bonus = 1 + 0.15 * Math.log(r.appearances.length);
      return base * bonus;
    });
    const rrfNorm    = normaliseScores(rawScores);

    // BM25 relevance blend: re-weight by query ↔ title+snippet similarity
    // This suppresses off-topic results that ranked well on a single engine
    const docs       = records.map((r) => `${r.title} ${r.snippet}`);
    const bm25Raw    = bm25Scores(this.query, docs);
    const normScores = this.query ? blendScores(rrfNorm, bm25Raw) : rrfNorm;

    // Build SearchResult array
    const results: SearchResult[] = records.map((r, i) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      score: normScores[i],
      sources: r.appearances.map((a) => a.engine) as SourceName[],
    }));

    // Sort descending by score, then by number of sources (tie-break)
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
      return b.sources.length - a.sources.length;
    });

    return results.slice(0, limit);
  }
}
