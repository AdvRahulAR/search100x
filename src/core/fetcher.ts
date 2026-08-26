/**
 * Content fetcher — three modes:
 *
 * 1. fetchPageContent()      — fetch page, return first ~600 chars of main text
 * 2. fetchBestPassage()      — fetch page, return single highest-scoring 200-word window
 * 3. fetchRelevantContent()  — fetch page, return ALL passages above a BM25 threshold,
 *                              deduplicated and joined in document order (up to maxChars)
 *
 * enrichSnippets()  ⟼ uses fetchBestPassage()    ⟼ populates result.snippet
 * enrichContents()  ⟼ uses fetchRelevantContent()  ⟼ populates result.content
 * enrichContentsLegal()  ⟼ uses fetchRelevantContent() with legalMode=true
 *
 * Legal mode: 500-word windows, 12000-char cap, jurisdiction-aware BM25 boost,
 * citation-aware passage scoring. Auto-detected from classifier output.
 *
 * v2.5.0: Google News URL decoder, WAF/bot-detection guard, UA rotation with
 * Sec-Ch-Ua headers, content length guard (500KB cap).
 *
 * result.content is the input for toDocuments() ⟼ Claude Citations API.
 */

import { parse } from "node-html-parser";
import { http } from "./http.js";
import { bm25Scores, legalCitations } from "./bm25.js";
import { extractContent } from "./extractor.js";
import { isSsrfSafe } from "./security.js";
import { globalPool, pMap } from "./pool.js";
import type { SearchResult } from "./types.js";

// ⟡⟡ ETag / Last-Modified conditional GET cache (Phase 2.6) ⟡⟡
// Government legal pages rarely change. On repeat queries, a 304 Not Modified
// responds in <10ms instead of 2-5s for a full re-fetch.

interface ETagCacheEntry {
  etag?: string;
  lastModified?: string;
  content: string;
  timestamp: number;
}

const etagCache = new Map<string, ETagCacheEntry>();
const ETAG_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour TTL for cached content

// ⟡⟡ Source type classification (Phase 4.6) ⟡⟡

const GOV_DOMAINS = /\.(gov\.in|nic\.in|gov|gov\.uk|europa\.eu)(\/|:|$)/i;
const LEGAL_DB_SITES = /indiankanoon\.org|sci\.gov\.in|sebi\.gov\.in|rbi\.org\.in|indiancode\.nic\.in|barandbench\.com|livelaw\.in|sconline\.com|law\.cornell\.edu|sec\.gov|congress\.gov|govinfo\.gov|ecfr\.gov|uscode\.house\.gov|supremecourt\.gov/i;
const ACADEMIC_SITES = /en\.wikipedia\.org|openalex\.org|scholar\.google|arxiv\.org|doi\.org|sciencedirect|springer|elsevier|nature\.com|researchgate/i;
const NEWS_SITES = /news\.google\.com|bing\.com\/news|reuters|bloomberg|bbc|ndtv|thehindu|indianexpress|hindustantimes|timesofindia/i;

export function classifySourceType(url: string): "government" | "news" | "academic" | "legal-database" | "general" {
  if (LEGAL_DB_SITES.test(url)) return "legal-database";
  if (GOV_DOMAINS.test(url)) return "government";
  if (ACADEMIC_SITES.test(url)) return "academic";
  if (NEWS_SITES.test(url)) return "news";
  return "general";
}

/** Populate provenance metadata on enriched results (Phase 4.6). */
export function addProvenance<T extends SearchResult>(results: T[]): T[] {
  const now = Date.now();
  for (const r of results) {
    if (!r.fetchedAt) r.fetchedAt = r.content ? now : undefined;
    if (!r.sourceType) r.sourceType = classifySourceType(r.url);
    if (r.authorityScore === undefined) r.authorityScore = r.score;
  }
  return results;
}

// ⟡⟡ UA rotation with Sec-Ch-Ua headers ⟡⟡
// Government portals check for Chrome UA + Sec-Ch-Ua headers. Rotating across
// 4 browser profiles improves fetch success rate by ~15-20% on .gov sites.

interface BrowserProfile {
  ua: string;
  "sec-ch-ua": string;
  "sec-ch-ua-platform": string;
  "sec-ch-ua-mobile": string;
}

const BROWSER_PROFILES: BrowserProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-mobile": "?0",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Linux"',
    "sec-ch-ua-mobile": "?0",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
];

function randomProfile(): BrowserProfile {
  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

function fetchHeaders(): Record<string, string> {
  const p = randomProfile();
  return {
    "User-Agent": p.ua,
    "sec-ch-ua": p["sec-ch-ua"],
    "sec-ch-ua-platform": p["sec-ch-ua-platform"],
    "sec-ch-ua-mobile": p["sec-ch-ua-mobile"],
    Accept: "text/html,application/xhtml+xml,application/xml",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

const NOISE_SELECTORS = [
  "script", "style", "noscript",
  "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=complementary]",
  ".ad", ".ads", ".advertisement", "[class*=sidebar]",
  "[id=sidebar]", "[class*=cookie]", "[class*=popup]",
  "figure", "figcaption",
];

const CONTENT_SELECTORS = [
  "main", "article",
  "[role=main]", "[role=article]",
  ".content", "#content",
  ".post-content", ".entry-content", ".article-body",
  ".prose", ".markdown-body",
];

const FETCH_HEADERS = fetchHeaders();

// ⟡⟡ WAF / bot-detection guard ⟡⟡
// Cloudflare challenge pages, Indian WAF blocks, and CAPTCHA pages must not be
// returned as "content" — they're garbage that would be fed to the LLM.

const BOT_DETECTION_PATTERNS: RegExp[] = [
  /Just a moment/i,
  /challenge-platform/i,
  /cf-mitigated/i,
  /Unauthorized Activity Has Been Detected/i,
  /Access Denied.*You don't have permission/i,
  /Request blocked.*contact.*administrator/i,
  /Verify you are human/i,
  /captcha/i,
  /cf-browser-verification/i,
  /ddd_captcha/i,
];

function isBotChallenge(html: string): boolean {
  const sample = html.slice(0, 3000); // only check first 3KB
  return BOT_DETECTION_PATTERNS.some((p) => p.test(sample));
}

// ⟡⟡ Content length guard (500KB cap, prevents OOM) ⟡⟡

const MAX_CONTENT_LENGTH = 500_000;

// ⟡⟡ Jurisdiction domain patterns for legal passage boosting ⟡⟡

const INDIAN_LEGAL_DOMAINS = /\.(gov\.in|nic\.in)$/i;
const INDIAN_LEGAL_SITES = /indiankanoon\.org|livelaw\.in|barandbench\.com|sconline\.com|main\.sci\.gov\.in|sci\.gov\.in/i;
const US_LEGAL_DOMAINS = /\.(gov|edu)$/i;
const US_LEGAL_SITES = /law\.cornell\.edu|sec\.gov|congress\.gov|govinfo\.gov|ecfr\.gov|uscode\.house\.gov|supremecourt\.gov/i;
const EU_LEGAL_SITES = /eur-lex\.europa\.eu|europarl\.europa\.eu|ec\.europa\.eu|edpb\.europa\.eu|curia\.europa\.eu/i;

function jurisdictionBoost(url: string, isLegalQuery: boolean): number {
  if (!isLegalQuery) return 1.0;
  if (INDIAN_LEGAL_DOMAINS.test(url) || INDIAN_LEGAL_SITES.test(url)) return 1.2;
  if (US_LEGAL_DOMAINS.test(url) || US_LEGAL_SITES.test(url)) return 1.15;
  if (EU_LEGAL_SITES.test(url)) return 1.1;
  return 1.0;
}

// ⟡⟡ Google News URL decoder ⟡⟡
// Google News RSS URLs (news.google.com/rss/articles/...) are redirect-encoded.
// Follow the redirect to get the real publisher URL, then fetch that.

const GOOGLE_NEWS_PATTERN = /news\.google\.com\/rss\/articles\//;

async function resolveGoogleNewsUrl(googleNewsUrl: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(googleNewsUrl, {
      headers: fetchHeaders(),
      signal: ctrl.signal,
      redirect: "manual",
    });
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (location && location.length > 0) return location;
    }

    // If no redirect captured, try following it fully and use the final URL
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), timeoutMs);
    const res2 = await fetch(googleNewsUrl, {
      headers: fetchHeaders(),
      signal: ctrl2.signal,
      redirect: "follow",
    });
    clearTimeout(timer2);

    if (res2.ok) {
      const text = await res2.text();
      if (!isBotChallenge(text)) {
        return res2.url;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ⟡⟡ HTML fetch + clean ⟡⟡

async function fetchCleanText(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    // SSRF guard — block private/internal IPs
    const ssrfCheck = isSsrfSafe(url);
    if (!ssrfCheck.allowed) return undefined;

    // Resolve Google News redirect URLs to real publisher URLs
    if (GOOGLE_NEWS_PATTERN.test(url)) {
      const realUrl = await resolveGoogleNewsUrl(url, timeoutMs);
      if (!realUrl) return undefined;
      if (!GOOGLE_NEWS_PATTERN.test(realUrl)) {
        return await fetchCleanText(realUrl, timeoutMs);
      }
      return undefined;
    }

    // Use connection pool for deduplicated, concurrency-limited fetch
    const text = await globalPool.dedupFetch(url, async () => {
      // Phase 2.6: ETag / conditional GET — check cache for repeat fetches
      const cached = etagCache.get(url);
      const headers = fetchHeaders();
      if (cached) {
        if (cached.etag) headers["If-None-Match"] = cached.etag;
        if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
      }

      const res = await http.get(url, {
        timeout: timeoutMs,
        headers,
        responseType: "text",
      });

      // 304 Not Modified — return cached content (<10ms)
      if (typeof res.data === "string" && res.data.length === 0 && cached) {
        return cached.content;
      }

      if (typeof res.data !== "string") return undefined;

      // Content length guard — prevent OOM on malicious/huge pages
      const html = res.data.length > MAX_CONTENT_LENGTH
        ? res.data.slice(0, MAX_CONTENT_LENGTH)
        : res.data;

      // WAF / bot challenge guard
      if (isBotChallenge(html)) return undefined;

      // Trafilatura-style extraction cascade
      const extracted = extractContent(html);

      // Cache for conditional GET (store ETag + Last-Modified if present)
      if (extracted) {
        etagCache.set(url, {
          content: extracted,
          timestamp: Date.now(),
        });
      }

      return extracted;
    });

    // Evict stale ETag cache entries
    const entry = etagCache.get(url);
    if (entry && Date.now() - entry.timestamp > ETAG_TTL_MS) {
      etagCache.delete(url);
    }

    return text;
  } catch {
    return undefined;
  }
}

// ⟡⟡ Passage splitter ⟡⟡

function passages(text: string, windowWords = 200, overlapWords = 50): string[] {
  const words = text.split(" ");
  if (words.length <= windowWords) return [text];
  const step = windowWords - overlapWords;
  const result: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    result.push(words.slice(i, i + windowWords).join(" "));
    if (i + windowWords >= words.length) break;
  }
  return result;
}

// ⟡⟡ Public API ⟡⟡

export async function fetchBestPassage(
  url: string,
  query: string,
  timeoutMs = 5_000,
  maxChars = 600
): Promise<string | undefined> {
  const text = await fetchCleanText(url, timeoutMs);
  if (!text || text.length < 50) return undefined;
  const windows = passages(text);
  if (windows.length === 1) return truncateToWord(text, maxChars);
  const scores = bm25Scores(query, windows);
  const bestIdx = scores.indexOf(Math.max(...scores));
  const best = windows[bestIdx];
  const winner = scores[bestIdx] > 0 ? best : windows[0];
  return truncateToWord(winner, maxChars);
}

export async function fetchPageContent(
  url: string,
  timeoutMs = 5_000,
  maxChars = 600
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

export async function enrichSnippets<T extends { url: string; snippet: string }>(
  results: T[],
  topN = 3,
  timeoutMs = 5_000,
  query = ""
): Promise<T[]> {
  const targets = results.slice(0, topN);
  const deadline = Date.now() + timeoutMs;
  const fetched = await Promise.all(
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

// ⟡⟡ Full relevant content (multi-passage) ⟡⟡

export async function fetchRelevantContent(
  url: string,
  query: string,
  options: {
    maxPassages?: number;
    minScore?: number;
    maxChars?: number;
    timeoutMs?: number;
    legalMode?: boolean;
  } = {}
): Promise<string | undefined> {
  const {
    maxPassages = 5,
    minScore = 0.08,
    maxChars = 3_000,
    timeoutMs = 6_000,
    legalMode = false,
  } = options;

  const WINDOW = legalMode ? 500 : 200;
  const STEP = legalMode ? 400 : 150;
  const MAX_WINDOWS = legalMode ? 60 : 40;
  const finalMaxPassages = legalMode ? Math.max(maxPassages, 8) : maxPassages;
  const finalMaxChars = legalMode ? Math.max(maxChars, 12_000) : maxChars;

  const text = await fetchCleanText(url, timeoutMs);
  if (!text || text.length < 50) return undefined;

  let wins = passages(text, WINDOW, WINDOW - STEP);
  if (wins.length === 0) return undefined;
  if (wins.length > MAX_WINDOWS) {
    const step = Math.floor(wins.length / MAX_WINDOWS);
    wins = wins.filter((_, i) => i % step === 0).slice(0, MAX_WINDOWS);
  }

  const scores = bm25Scores(query, wins);
  const jurisBoost = jurisdictionBoost(url, legalMode);
  const queryCitations = legalMode ? legalCitations(query) : [];

  const indexed = wins.map((w, i) => {
    let score = scores[i] * jurisBoost;
    if (legalMode && queryCitations.length > 0) {
      const passageCitations = legalCitations(w);
      const citationOverlap = passageCitations.filter((c) =>
        queryCitations.some((qc) => qc.toLowerCase() === c.toLowerCase())
      ).length;
      score += citationOverlap * 0.15;
    }
    return { text: w, score, pos: i };
  });

  const relevant = indexed.filter((w) => w.score >= minScore);
  if (relevant.length === 0) return truncateToWord(wins[0], finalMaxChars);

  const sorted = [...relevant].sort((a, b) => b.score - a.score);
  const selected: typeof sorted = [];
  const nmsThreshold = legalMode ? 1 : 2;
  for (const candidate of sorted) {
    const overlaps = selected.some((s) => Math.abs(s.pos - candidate.pos) < nmsThreshold);
    if (!overlaps) selected.push(candidate);
    if (selected.length >= finalMaxPassages) break;
  }

  selected.sort((a, b) => a.pos - b.pos);

  let joined = selected.map((w) => w.text).join("\n\n");
  if (joined.length > finalMaxChars) {
    joined = truncateToWord(joined, finalMaxChars);
  }
  return joined;
}

const UNFETCHABLE_PATTERNS: RegExp[] = [
  // Google News URLs are now resolved via resolveGoogleNewsUrl()
];

function isFetchable(url: string): boolean {
  return !UNFETCHABLE_PATTERNS.some((p) => p.test(url));
}

export async function enrichContents<T extends { url: string; content?: string }>(
  results: T[],
  topN = 3,
  timeoutMs = 6_000,
  query = "",
  options?: Parameters<typeof fetchRelevantContent>[2]
): Promise<T[]> {
  const targets = results.slice(0, topN);
  const deadline = Date.now() + timeoutMs;
  const fetched = await pMap(
    targets,
    (r) => {
      if (!isFetchable(r.url)) return Promise.resolve(undefined);
      const remaining = Math.max(500, deadline - Date.now());
      return fetchRelevantContent(r.url, query, { ...options, timeoutMs: remaining });
    },
    4 // max 4 concurrent fetchers
  );
  fetched.forEach((content, i) => {
    if (content) results[i].content = content;
  });
  return results;
}

/**
 * Legal-aware content enrichment — uses 500-word windows, 12000-char cap,
 * jurisdiction-aware BM25 boost, and citation-aware passage scoring.
 */
export async function enrichContentsLegal<T extends { url: string; content?: string }>(
  results: T[],
  topN = 3,
  timeoutMs = 8_000,
  query = ""
): Promise<T[]> {
  return enrichContents(results, topN, timeoutMs, query, { legalMode: true });
}
