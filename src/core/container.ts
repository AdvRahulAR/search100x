import { RawResult, Appearance, MergedResult, SearchResult, SourceName } from "./types.js";
import { normalizeUrl, urlKey } from "./normalizer.js";
import { engineWeight, rrfScore, normaliseScores, cascadeScore, CascadeWeights, DEFAULT_WEIGHTS } from "./scorer.js";
import { bm25Scores, normaliseScores as normaliseBm25 } from "./bm25.js";

interface Record {
  title:             string;
  url:               string;
  snippet:           string;
  titleEngineWeight: number;
  appearances:       Appearance[];
  publishedAt?:      Date;
  subEngines:        string[];   // union of sub-engine names across all SearXNG appearances
}

export class ResultContainer {
  private map   = new Map<number, Record>();
  private query: string;

  constructor(query = "") {
    this.query = query;
  }

  add(engineName: string, results: RawResult[]): void {
    const weight = engineWeight(engineName);

    results.forEach((raw, index) => {
      if (!raw.url || !raw.title) return;

      const rank       = index + 1;
      const norm       = normalizeUrl(raw.url);
      const key        = urlKey(norm);
      const appearance: Appearance = { engine: engineName, weight, rank };

      const existing = this.map.get(key);
      if (!existing) {
        this.map.set(key, {
          title:             raw.title,
          url:               raw.url,
          snippet:           raw.snippet,
          titleEngineWeight: weight,
          appearances:       [appearance],
          publishedAt:       raw.publishedAt,
          subEngines:        raw.subEngines ?? [],
        });
        return;
      }

      // Deduplicate appearances — same (engine, rank) from parallel scoped variants
      const isDuplicate = existing.appearances.some(
        (a) => a.engine === engineName && a.rank === rank
      );
      if (!isDuplicate) existing.appearances.push(appearance);

      // Accumulate SearXNG sub-engine names for consensus weighting
      if (raw.subEngines) {
        for (const se of raw.subEngines) {
          if (!existing.subEngines.includes(se)) existing.subEngines.push(se);
        }
      }

      // Title: prefer higher-weight engine
      if (weight > existing.titleEngineWeight) {
        existing.title             = raw.title;
        existing.titleEngineWeight = weight;
      }

      // Snippet: prefer longer
      if (raw.snippet.length > existing.snippet.length) {
        existing.snippet = raw.snippet;
      }

      // publishedAt: keep the earliest known date (first publication)
      if (raw.publishedAt && (!existing.publishedAt || raw.publishedAt < existing.publishedAt)) {
        existing.publishedAt = raw.publishedAt;
      }
    });
  }

  getResults(limit: number, weights: CascadeWeights = DEFAULT_WEIGHTS, halfLifeDays = 30): SearchResult[] {
    const records = [...this.map.values()];
    if (records.length === 0) return [];

    // ── RRF with logarithmic consensus bonus ──────────────────────────────────
    // SearXNG sub-engine count provides an additional signal: a result confirmed
    // by 5 Google/Bing/Brave/DDG sub-engines inside SearXNG is more trustworthy
    // than one that only one sub-engine returned.
    const rawRrf = records.map((r) => {
      const base         = rrfScore(r.appearances);
      const engineBonus  = 1 + 0.15 * Math.log(r.appearances.length);
      const subEngCount  = Math.max(1, r.subEngines.length);
      const subEngBonus  = subEngCount > 1 ? 1 + 0.12 * Math.log(subEngCount) : 1;
      return base * engineBonus * subEngBonus;
    });
    const rrfNorm = normaliseScores(rawRrf);

    // ── BM25 term relevance ───────────────────────────────────────────────────
    const docs    = records.map((r) => `${r.title} ${r.snippet}`);
    const bm25Raw = bm25Scores(this.query, docs);
    const bm25Norm = this.query ? normaliseBm25(bm25Raw) : bm25Raw.map(() => 0.5);

    // ── Cascade score ─────────────────────────────────────────────────────────
    const results: SearchResult[] = records.map((r, i) => ({
      title:       r.title,
      url:         r.url,
      snippet:     r.snippet,
      score:       cascadeScore(rrfNorm[i], bm25Norm[i], r.url, r.publishedAt, weights, halfLifeDays),
      sources:     r.appearances.map((a) => a.engine) as SourceName[],
      publishedAt: r.publishedAt,
    }));

    results.sort((a, b) => {
      const d = b.score - a.score;
      if (Math.abs(d) > 1e-9) return d;
      return b.sources.length - a.sources.length;
    });

    return results.slice(0, limit);
  }
}
