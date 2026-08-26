import { createHash } from "crypto";

// Query params that carry no semantic content — strip before hashing
const NOISE_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "referrer", "source", "fbclid", "gclid", "msclkid",
  "oc",  // Google News article tracker
]);

/**
 * Canonical URL → string key used for deduplication.
 *
 * Rules (in order):
 *  1. Force https
 *  2. Strip www. prefix
 *  3. Lowercase host + path
 *  4. Remove tracking query params
 *  5. Sort remaining params for stability
 *  6. Strip fragment (#)
 *  7. Strip trailing slash from path (but keep "/" for roots)
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a valid URL — use lowercase string as-is
    return raw.toLowerCase().trim();
  }

  url.protocol = "https:";
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (NOISE_PARAMS.has(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  let path = url.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;

  return url.toString();
}

/**
 * Stable integer key for a normalized URL.
 * Uses a 52-bit truncation of SHA-256 so it fits a JS number safely.
 */
export function urlKey(normalized: string): number {
  const buf = createHash("sha256").update(normalized).digest();
  // Read first 6 bytes (48 bits) — well within Number.MAX_SAFE_INTEGER
  return buf.readUIntBE(0, 6);
}

/** Strip HTML tags + decode common entities */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cap at maxLen chars on a word boundary */
export function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen);
  return (cut > maxLen / 2 ? text.slice(0, cut) : text.slice(0, maxLen)) + "…";
}
