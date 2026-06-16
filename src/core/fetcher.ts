/**
 * Content fetcher — three modes:
 *
 * 1. fetchPageContent()      — fetch page, return first ~600 chars of main text
 * 2. fetchBestPassage()      — fetch page, return single highest-scoring 200-word window
 * 3. fetchRelevantContent()  — fetch page, return ALL passages above a BM25 threshold,
 *                              deduplicated and joined in document order (up to maxChars)
 *
 * enrichSnippets()  → uses fetchBestPassage()     → populates result.snippet
 * enrichContents()  → uses fetchRelevantContent() → populates result.content
 *
 * result.content is the input for toDocuments() → Claude Citations API.
 */

import { parse } from "node-html-parser";
import { http } from "./http.js";
import { bm25Scores } from "./bm25.js";

const FETCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0";

const NOISE_SELECTORS = [
  "script", "style", "noscript",
  "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=complementary]",
  ".ad", ".ads", ".advertisement", "[class*=sidebar]",
  "[id*=sidebar]", "[class*=cookie]", "[class*=popup]",
  "figure", "figcaption",
];

const CONTENT_SELECTORS = [
  "main", "article",
  "[role=main]", "[role=article]",
  ".content", "#content",
  ".post-content", ".entry-content", ".article-body",
  ".prose", ".markdown-body",
];

const FETCH_HEADERS = {
  "User-Agent":      FETCH_UA,
  Accept:            "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── HTML fetch + clean ────────────────────────────────────────────────────────

async function fetchCleanText(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const res = await http.get(url, {
      timeout: timeoutMs,
      headers: FETCH_HEADERS,
      responseType: "text",
    });

    if (typeof res.data !== "string") return undefined;

    const root = parse(res.data);
    for (const sel of NOISE_SELECTORS) {
      root.querySelectorAll(sel).forEach((n) => n.remove());
    }

    let text = "";
    for (const sel of CONTENT_SELECTORS) {
      text = root.querySelector(sel)?.text.trim() ?? "";
      if (text.length > 100) break;
    }
    if (text.length < 100) text = root.querySelector("body")?.text.trim() ?? "";

    return text.replace(/\s+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── Passage splitter ──────────────────────────────────────────────────────────

/**
 * Split text into overlapping ~200-word windows.
 * Overlap of 50 words prevents a relevant sentence being cut across a boundary.
 */
function passages(text: string, windowWords = 200, overlapWords = 50): string[] {
  const words = text.split(" ");
  if (words.length <= windowWords) return [text];

  const step   = windowWords - overlapWords;
  const result: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    result.push(words.slice(i, i + windowWords).join(" "));
    if (i + windowWords >= words.length) break;
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the URL and return the passage most relevant to `query`.
 * Falls back to the first 600 chars if BM25 scoring finds nothing useful.
 */
export async function fetchBestPassage(
  url:       string,
  query:     string,
  timeoutMs  = 5_000,
  maxChars   = 600
): Promise<string | undefined> {
  const text = await fetchCleanText(url, timeoutMs);
  if (!text || text.length < 50) return undefined;

  const windows = passages(text);

  if (windows.length === 1) {
    // Short page — just truncate
    return truncateToWord(text, maxChars);
  }

  // Score each passage against the query with BM25
  const scores  = bm25Scores(query, windows);
  const bestIdx = scores.indexOf(Math.max(...scores));
  const best    = windows[bestIdx];

  // If BM25 found no overlap (all zeros), fall back to first passage
  const winner = scores[bestIdx] > 0 ? best : windows[0];
  return truncateToWord(winner, maxChars);
}

/**
 * Legacy: fetch URL and return first ~maxChars of cleaned main content.
 * Used when no query is available.
 */
export async function fetchPageContent(
  url:      string,
  timeoutMs = 5_000,
  maxChars  = 600
): Promise<string | undefined> {
  const text = await fetchCleanText(url, timeoutMs);
  if (!text || text.length < 50) return undefined;
  return truncateToWord(text, maxChars);
}

function truncateToWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars) + "…";
}

/**
 * Enrich top-N results with best-passage content fetched in parallel.
 * Replaces the snippet only when the fetched passage is longer and non-empty.
 */
export async function enrichSnippets<T extends { url: string; snippet: string }>(
  results:   T[],
  topN       = 3,
  timeoutMs  = 5_000,
  query      = ""
): Promise<T[]> {
  const targets  = results.slice(0, topN);
  const deadline = Date.now() + timeoutMs;
  const fetched  = await Promise.all(
    targets.map((r) => {
      if (!isFetchable(r.url)) return Promise.resolve(undefined);
      const remaining = Math.max(500, deadline - Date.now());
      return query
        ? fetchBestPassage(r.url, query, remaining)
        : fetchPageContent(r.url, remaining);
    })
  );
  fetched.forEach((content, i) => {
    if (content && content.length > results[i].snippet.length) {
      results[i].snippet = content;
    }
  });
  return results;
}

// ── Full relevant content (multi-passage) ─────────────────────────────────────

/**
 * Fetch a page and return ALL passages that are relevant to the query,
 * joined in document order.
 *
 * Algorithm:
 *  1. Score every 200-word window with BM25 against the query
 *  2. Discard windows scoring below minScore (irrelevant noise)
 *  3. Non-maximum suppression: greedily select non-overlapping windows
 *     in score-descending order, up to maxPassages
 *  4. Re-sort selected windows by their position in the document
 *  5. Join with "\n\n" — coherent reading order, multiple angles covered
 *
 * This is what makes cited answers work: the LLM sees the full relevant
 * section of each article, not just the opening paragraph.
 */
export async function fetchRelevantContent(
  url:      string,
  query:    string,
  options: {
    maxPassages?: number;  // max non-overlapping passages to include (default 5)
    minScore?:   number;   // BM25 threshold — passages below this are noise (default 0.08)
    maxChars?:   number;   // hard cap on total returned chars (default 3000)
    timeoutMs?:  number;
  } = {}
): Promise<string | undefined> {
  const {
    maxPassages = 5,
    minScore    = 0.08,
    maxChars    = 3_000,
    timeoutMs   = 6_000,
  } = options;

  const text = await fetchCleanText(url, timeoutMs);
  if (!text || text.length < 50) return undefined;

  const WINDOW     = 200;
  const STEP       = 150; // non-overlap stride (200 - 50 overlap)
  const MAX_WINDOWS = 40; // cap memory use on very long docs (50k+ words)

  let wins = passages(text, WINDOW, WINDOW - STEP);
  if (wins.length === 0) return undefined;
  // Sample evenly across document if too many windows
  if (wins.length > MAX_WINDOWS) {
    const step = Math.floor(wins.length / MAX_WINDOWS);
    wins = wins.filter((_, i) => i % step === 0).slice(0, MAX_WINDOWS);
  }

  // Score all windows
  const scores  = bm25Scores(query, wins);

  // Pair each window with its score and position index
  const indexed = wins.map((w, i) => ({ text: w, score: scores[i], pos: i }));

  // Filter below threshold
  const relevant = indexed.filter((w) => w.score >= minScore);
  if (relevant.length === 0) {
    // Nothing relevant found — fall back to first passage
    return truncateToWord(wins[0], maxChars);
  }

  // Non-maximum suppression: greedy selection in score-descending order.
  // Windows with STEP=150 words overlap when their indices differ by < 2
  // (pos 0 = words 0–199, pos 1 = words 150–349 → 50-word overlap).
  // Using < 2 ensures adjacent windows don't both get selected.
  const sorted  = [...relevant].sort((a, b) => b.score - a.score);
  const selected: typeof sorted = [];
  for (const candidate of sorted) {
    const overlaps = selected.some((s) => Math.abs(s.pos - candidate.pos) < 2);
    if (!overlaps) selected.push(candidate);
    if (selected.length >= maxPassages) break;
  }

  // Re-sort by document position for coherent reading order
  selected.sort((a, b) => a.pos - b.pos);

  // Join and cap
  let joined = selected.map((w) => w.text).join("\n\n");
  if (joined.length > maxChars) {
    joined = truncateToWord(joined, maxChars);
  }
  return joined;
}

/**
 * Enrich top-N results with full relevant content fetched in parallel.
 * Populates result.content (does NOT replace snippet).
 * Results with no fetchable content keep content undefined.
 */
// URLs that redirect to content behind a login or JS wall — fetching yields nothing useful.
const UNFETCHABLE_PATTERNS = [
  /news\.google\.com\/rss\/articles\//,
  /news\.google\.com\/stories\//,
];

function isFetchable(url: string): boolean {
  return !UNFETCHABLE_PATTERNS.some((p) => p.test(url));
}

export async function enrichContents<T extends { url: string; content?: string }>(
  results:  T[],
  topN      = 3,
  timeoutMs = 6_000,
  query     = "",
  options?: Parameters<typeof fetchRelevantContent>[2]
): Promise<T[]> {
  // Only attempt to fetch URLs that are not known redirect walls
  const targets  = results.slice(0, topN);
  const deadline = Date.now() + timeoutMs;
  const fetched  = await Promise.all(
    targets.map((r) => {
      if (!isFetchable(r.url)) return Promise.resolve(undefined);
      const remaining = Math.max(500, deadline - Date.now());
      return fetchRelevantContent(r.url, query, { ...options, timeoutMs: remaining });
    })
  );
  fetched.forEach((content, i) => {
    if (content) results[i].content = content;
  });
  return results;
}
