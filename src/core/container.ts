import { RawResult, Appearance, MergedResult, SearchResult, SourceName } from "./types.js";
import { normalizeUrl, urlKey } from "./normalizer.js";
import { engineWeight, rrfScore, normaliseScores, cascadeScore, CascadeWeights, DEFAULT_WEIGHTS, adaptiveK } from "./scorer.js";
import { tokenize, snippetRelevanceScore } from "./bm25.js";
import { clusterResults } from "./cluster.js";

interface Record {
  title:             string;
  url:               string;
  snippet:           string;
  titleEngineWeight: number;
  appearances:       Appearance[];
  publishedAt?:      Date;
  subEngines:        string[];   // union of sub-engine names across all SearXNG appearances
}

function urlShingles(url: string, n = 3): Set<string> {
  try {
    const u    = new URL(url);
    const toks = u.pathname.split(/[-_/]/).filter(t => t.length > 2);
    const sh   = new Set<string>();
    for (let i = 0; i <= toks.length - n; i++) {
      sh.add(toks.slice(i, i + n).join("_"));
    }
    sh.add(u.hostname.replace(/^www\./, ""));
    return sh;
  } catch {
    return new Set([url]);
  }
}

const HASH_PARAMS = Array.from({length: 16}, (_, i) => ({
  a: BigInt(2654435769 + i * 1234567),
  b: BigInt(i * 987654321 + 13),
  m: (1n << 32n),
}));

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function minHashSig(shingles: Set<string>): Uint32Array {
  const sig = new Uint32Array(16).fill(0xFFFFFFFF);
  for (const sh of shingles) {
    const h = fnv1a32(sh);
    for (let i = 0; i < 16; i++) {
      const hashed = Number((HASH_PARAMS[i].a * BigInt(h) + HASH_PARAMS[i].b) % HASH_PARAMS[i].m);
      if (hashed < sig[i]) sig[i] = hashed;
    }
  }
  return sig;
}

function jaccardEstimate(a: Uint32Array, b: Uint32Array): number {
  let matches = 0;
  for (let i = 0; i < 16; i++) if (a[i] === b[i]) matches++;
  return matches / 16;
}

function mmrSelect(
  candidates: SearchResult[],
  limit: number,
  λ = 0.65
): SearchResult[] {
  const selected: SearchResult[] = [];
  const remaining = [...candidates];

  const first = remaining.splice(
    remaining.reduce((best, r, i) => r.score > remaining[best].score ? i : best, 0), 1
  )[0];
  if (first) {
    selected.push(first);
  }

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const rel = r.score;
      const maxSim = selected.length > 0
        ? Math.max(...selected.map(s => jaccardTokens(r.title, s.title)))
        : 0;
      const mmr = λ * rel - (1 - λ) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    const next = remaining.splice(bestIdx, 1)[0];
    next.score = bestScore;
    selected.push(next);
  }

  return selected;
}

function jaccardTokens(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/\s+/));
  const B = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...A].filter(t => B.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : intersection / union;
}

export class ResultContainer {
  private map   = new Map<number, Record>();
  private query: string;

  constructor(query = "") {
    this.query = query;
  }

  get size(): number {
    return this.map.size;
  }

  add(engineName: string, results: RawResult[]): void {
    const weight = engineWeight(engineName);

    results.forEach((raw, index) => {
      if (!raw.url || !raw.title) return;

      const rank       = index + 1;
      const norm       = normalizeUrl(raw.url);
      const key        = urlKey(norm);
      const appearance: Appearance = { engine: engineName, weight, rank, providerScore: raw.providerScore };

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
    const K_val = adaptiveK(records.length);
    const engines = new Set<string>();
    const rawRrf = records.map((r) => {
      for (const a of r.appearances) {
        engines.add(a.engine);
      }
      const base         = rrfScore(r.appearances, K_val);
      const engineBonus  = 1 + 0.15 * Math.log(r.appearances.length);
      const subEngCount  = Math.max(1, r.subEngines.length);
      const subEngBonus  = subEngCount > 1 ? 1 + 0.12 * Math.log(subEngCount) : 1;
      return base * engineBonus * subEngBonus;
    });
    const engineCount = Math.max(1, engines.size);
    const rrfNorm = normaliseScores(rawRrf, engineCount);

    // ── BM25 term relevance (snippet-level) ───────────────────────────────────
    const queryTokens = tokenize(this.query);
    const bm25Norm = records.map((r) => snippetRelevanceScore(r.snippet, queryTokens));

    // ── Cascade score ─────────────────────────────────────────────────────────
    const results: SearchResult[] = records.map((r, i) => ({
      title:       r.title,
      url:         r.url,
      snippet:     r.snippet,
      score:       cascadeScore(rrfNorm[i], bm25Norm[i], r.url, r.publishedAt, weights, halfLifeDays, r.title, r.snippet),
      sources:     r.appearances.map((a) => a.engine) as SourceName[],
      publishedAt: r.publishedAt,
    }));

    results.sort((a, b) => {
      const d = b.score - a.score;
      if (Math.abs(d) > 1e-9) return d;
      return b.sources.length - a.sources.length;
    });

    // MinHash near-duplicate detection on top 200
    const top200 = results.slice(0, 200);
    const deduped: SearchResult[] = [];
    const sigs: Uint32Array[] = [];

    for (const r of top200) {
      const shingles = urlShingles(r.url);
      const sig = minHashSig(shingles);
      let isDup = false;
      for (const existingSig of sigs) {
        if (jaccardEstimate(sig, existingSig) > 0.85) {
          isDup = true;
          break;
        }
      }
      if (!isDup) {
        deduped.push(r);
        sigs.push(sig);
      }
    }

    const remainingResults = results.slice(200);
    const postDedup = [...deduped, ...remainingResults];

    // MMR selection for diversity followed by subtopic clustering
    const mmrResults = mmrSelect(postDedup, limit);
    return clusterResults(mmrResults, limit);
  }
}
