import { Appearance } from "./types.js";

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
