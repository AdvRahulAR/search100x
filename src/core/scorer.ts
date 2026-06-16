import { Appearance } from "./types.js";

// ── Authority scoring ─────────────────────────────────────────────────────────

const GOV_EDU = /\.(gov|edu|ac\.[a-z]{2,4})$/;
const TRUSTED  = /wikipedia\.org|reuters\.com|bbc\.(com|co\.uk)|arxiv\.org|pubmed\.ncbi|nature\.com|science\.org/;
const ORG      = /\.org$/;

/** Heuristic domain trust score in [0, 1]. Pure URL parsing, zero network cost. */
export function urlAuthorityScore(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (GOV_EDU.test(host))  return 1.00;
    if (TRUSTED.test(host))  return 0.80;
    if (ORG.test(host))      return 0.70;
    return 0.50;
  } catch {
    return 0.50;
  }
}

// ── Recency scoring ───────────────────────────────────────────────────────────

/**
 * Exponential decay keyed on publication age.
 * halfLifeDays=30  → news/general (today=1.0, 30d→0.50, 90d→0.125)
 * halfLifeDays=365 → legal/academic (content validity spans years)
 * Returns 0.50 when publishedAt is unknown — neutral, not penalised.
 */
export function recencyScore(publishedAt?: Date, halfLifeDays = 30): number {
  if (!publishedAt) return 0.50;
  const ageDays = (Date.now() - publishedAt.getTime()) / 86_400_000;
  return Math.exp((-ageDays * Math.LN2) / halfLifeDays);
}

// ── Cascade weights ───────────────────────────────────────────────────────────

export interface CascadeWeights {
  rrf:       number;
  bm25:      number;
  authority: number;
  recency:   number;
}

/** General web / mixed queries */
export const DEFAULT_WEIGHTS: CascadeWeights  = { rrf: 0.45, bm25: 0.30, authority: 0.15, recency: 0.10 };
/** News / current-events queries — freshness dominates */
export const NEWS_WEIGHTS: CascadeWeights     = { rrf: 0.40, bm25: 0.25, authority: 0.10, recency: 0.25 };
/** Legal / regulatory — authority and term precision dominate; recency near-zero */
export const LEGAL_WEIGHTS: CascadeWeights    = { rrf: 0.45, bm25: 0.35, authority: 0.18, recency: 0.02 };
/** Academic — authority (gov/edu/org) and term match dominate */
export const ACADEMIC_WEIGHTS: CascadeWeights = { rrf: 0.42, bm25: 0.33, authority: 0.22, recency: 0.03 };

export const SCORING_PRESETS: Record<string, CascadeWeights> = {
  default:  DEFAULT_WEIGHTS,
  news:     NEWS_WEIGHTS,
  legal:    LEGAL_WEIGHTS,
  academic: ACADEMIC_WEIGHTS,
};

// ── Cascade blend ─────────────────────────────────────────────────────────────

/**
 * Four-factor cascade score.
 * All inputs are already normalised to [0, 1].
 * weights must sum to 1.0 for the output to remain in [0, 1].
 */
export function cascadeScore(
  rrfNorm:    number,
  bm25Norm:   number,
  url:        string,
  publishedAt?: Date,
  weights:    CascadeWeights = DEFAULT_WEIGHTS,
  halfLifeDays = 30
): number {
  return (
    weights.rrf       * rrfNorm +
    weights.bm25      * bm25Norm +
    weights.authority * urlAuthorityScore(url) +
    weights.recency   * recencyScore(publishedAt, halfLifeDays)
  );
}

/**
 * Reciprocal Rank Fusion
 * ──────────────────────
 * Standard formula (Cormack, Clarke & Buettcher, SIGIR 2009):
 *
 *   RRF(d) = Σ_e  w_e / (k + rank_e(d))
 *
 * where:
 *   d        = document (search result)
 *   e        = engine that returned d
 *   w_e      = engine weight  (trust factor, [0,1])
 *   rank_e   = 1-indexed position of d in engine e's result list
 *   k        = smoothing constant (default 60, standard in literature)
 *
 * Properties:
 *  - A document at rank 1 in one engine: contributes  w_e / (60+1) ≈ 0.0164 w_e
 *  - Same document also at rank 10:      extra        w_e / (60+10) ≈ 0.0143 w_e
 *  - Cross-engine agreement accumulates score linearly
 *  - k=60 prevents a single top-ranked result from dominating over
 *    a consensus result that appears in many engines at moderate ranks
 *
 * Scaling:
 *  - Adding a new engine = adding an entry to WEIGHTS, implementing the adapter
 *  - Changing k shifts the balance between rank-1 dominance and multi-engine consensus
 */

// k=10 calibrated for our corpus size (60–100 results across 6–10 engines).
// The original k=60 was designed for TREC corpora of 1000+ documents — it
// flattens rank differences at small N, making rank-1 and rank-5 nearly
// indistinguishable. At k=10, rank-1 vs rank-5 separation is 3× wider.
export const K = 10;

/** Engine trust weights — must sum to ≤ N (they don't need to sum to 1) */
export const ENGINE_WEIGHTS: Record<string, number> = {
  // Premium (API-backed, high-quality indices)
  tavily:     1.00,
  google:     1.00,
  brave:      0.90,
  // Free web scrapers (SearXNG-derived mechanisms)
  duckduckgo: 0.80,
  bing:       0.75,
  mojeek:     0.65,
  // Structured/RSS (authoritative but narrow coverage)
  googlenews: 0.85,
  bingnews:   0.75,
  wikipedia:  0.80,
  openalex:   0.70,
  // SearXNG aggregates ~70 sub-engines; base weight reflects that it's one HTTP
  // call, but the sub-engine consensus bonus in container.ts boosts confirmed results.
  searxng:    0.90,
};

export function engineWeight(name: string): number {
  return ENGINE_WEIGHTS[name] ?? 0.60;
}

/**
 * Compute the RRF score for a result given all its appearances.
 *
 * @param appearances  List of (engine, weight, rank) tuples
 * @returns            RRF score ∈ (0, ∞)  — higher is better
 */
export function rrfScore(appearances: Appearance[]): number {
  return appearances.reduce(
    (sum, { weight, rank }) => sum + weight / (K + rank),
    0
  );
}

/**
 * Normalise a list of RRF scores into [0, 1].
 * Uses min-max normalisation across the result set.
 * If all scores are equal (edge case), returns 0.5 for all.
 */
export function normaliseScores(
  scores: number[]
): number[] {
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => 0.5);
  return scores.map((s) => (s - min) / range);
}
