import { Appearance } from "./types.js";
import { domainReputation, spamSignalScore } from "./reputation.js";

// ── Authority scoring ─────────────────────────────────────────────────────────

const GOV_EDU = /\.(gov|edu|ac\.[a-z]{2,4})$/;
const TRUSTED  = /wikipedia\.org|reuters\.com|bbc\.(com|co\.uk)|arxiv\.org|pubmed\.ncbi|nature\.com|science\.org/;
const ORG      = /\.org$/;

/** Heuristic domain trust score in [0, 1]. Pure URL parsing, zero network cost. */
export function urlAuthorityScore(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    let tldScore = 0.50;
    if (GOV_EDU.test(host))  tldScore = 1.00;
    else if (TRUSTED.test(host))  tldScore = 0.80;
    else if (ORG.test(host))      tldScore = 0.70;
    return Math.min(1.0, tldScore * domainReputation(url));
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
  halfLifeDays = 30,
  title = "",
  snippet = ""
): number {
  const spamMultiplier = spamSignalScore(title, snippet);
  return (
    weights.rrf       * rrfNorm +
    weights.bm25      * bm25Norm +
    weights.authority * urlAuthorityScore(url) * spamMultiplier +
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
 *  - A document at rank 1 in one engine: contributes  w_e / (10+1) ≈ 0.091 w_e
 *  - Same document also at rank 10:      extra        w_e / (10+10) ≈ 0.050 w_e
 *  - Cross-engine agreement accumulates score linearly
 *  
 * Note: k=10 (not literature standard 60) is chosen to favor top results
 * more heavily for LLM grounding use case. Higher k would flatten scores.
 */

export const K = 10;

const PROVIDER_ALPHA: Record<string, number> = {
  tavily: 0.30,   // trust Tavily scores moderately
  brave:  0.20,   // trust Brave scores less
  google: 0.25,
  searxng: 0.00,  // SearXNG doesn't have reliable scores
};

export function adjustedRank(rank: number, providerScore?: number, engine?: string): number {
  if (!engine) return rank;
  const α = PROVIDER_ALPHA[engine] ?? 0;
  if (!providerScore || α === 0) return rank;
  const s = Math.max(0, Math.min(1, providerScore));
  return rank * (1 - α * s);
}

// Adaptive K factors
const ADAPTIVE_K_BASE = 0.29;      // Scaling factor for result count
const ADAPTIVE_K_MIN = 10;          // Minimum k value
const ADAPTIVE_K_MAX = 150;         // Maximum k value

// Sigmoid normalization parameters
const SIGMOID_MU_BASE = 0.12;       // Median RRF score reference
const SIGMOID_BETA = 0.04;          // Sharpness of separation

export function adaptiveK(totalResults: number): number {
  return Math.min(
    ADAPTIVE_K_MAX, 
    Math.max(ADAPTIVE_K_MIN, Math.floor(ADAPTIVE_K_BASE * totalResults))
  );
}

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
  marginalia: 0.62,
  yep:        0.70,
  // Structured/RSS (authoritative but narrow coverage)
  googlenews: 0.85,
  bingnews:   0.75,
  wikipedia:  0.80,
  openalex:   0.70,
  // SearXNG aggregates ~70 sub-engines; base weight reflects that it's one HTTP
  // call, but the sub-engine consensus bonus in container.ts boosts confirmed results.
  searxng:    0.90,
  // Live-data adapters: always rank first when present — real data > indexed pages
  openmeteo:  1.00,
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
export function rrfScore(appearances: Appearance[], rrfK = K): number {
  return appearances.reduce(
    (sum, a) => sum + a.weight / (rrfK + adjustedRank(a.rank, a.providerScore, a.engine)),
    0
  );
}

/**
 * Normalise a list of RRF scores into [0, 1].
 * Uses shifted sigmoid normalisation scaled by engine count.
 */
export function normaliseScores(scores: number[], engineCount = 3): number[] {
  const mu = SIGMOID_MU_BASE * (engineCount / 3);
  const beta = SIGMOID_BETA;
  return scores.map(x => 1 / (1 + Math.exp(-(x - mu) / beta)));
}

