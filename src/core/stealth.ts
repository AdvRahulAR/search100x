/**
 * Stealth — centralized User-Agent rotation, browser profile simulation,
 * and per-domain rate limiting.
 *
 * All adapters should import their request headers from here instead of
 * hardcoding static User-Agent strings.
 */

// --- Browser Profiles ---

export interface BrowserProfile {
  ua: string;
  "sec-ch-ua": string;
  "sec-ch-ua-platform": string;
  "sec-ch-ua-mobile": string;
}

const PROFILES: BrowserProfile[] = [
  // Chrome 134 Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="134", "Chromium";v="134", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
  // Chrome 134 macOS
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="134", "Chromium";v="134", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-ch-ua-mobile": "?0",
  },
  // Chrome 133 Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="133", "Chromium";v="133", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
  // Chrome 133 Linux
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="133", "Chromium";v="133", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Linux"',
    "sec-ch-ua-mobile": "?0",
  },
  // Firefox 134 Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
    "sec-ch-ua": "",
    "sec-ch-ua-platform": "",
    "sec-ch-ua-mobile": "",
  },
  // Firefox 133 macOS
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    "sec-ch-ua": "",
    "sec-ch-ua-platform": "",
    "sec-ch-ua-mobile": "",
  },
  // Edge 134 Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
    "sec-ch-ua": '"Microsoft Edge";v="134", "Chromium";v="134", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
  // Chrome 132 Windows
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="132", "Chromium";v="132", "Not_A Brand";v="24"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-mobile": "?0",
  },
];

let profileIndex = 0;

/** Round-robin profile selection for consistent request fingerprinting */
export function getProfile(): BrowserProfile {
  const p = PROFILES[profileIndex % PROFILES.length];
  profileIndex++;
  return p;
}

/** Get a random profile (use when session pinning is not needed) */
export function getRandomProfile(): BrowserProfile {
  return PROFILES[Math.floor(Math.random() * PROFILES.length)];
}

/**
 * Pinned profile cache — engines like DuckDuckGo bind VQD tokens to
 * the originating User-Agent. This ensures the same UA is used across
 * multiple requests in the same search session.
 */
const pinnedProfiles = new Map<string, BrowserProfile>();

export function getPinnedProfile(key: string): BrowserProfile {
  if (!pinnedProfiles.has(key)) {
    pinnedProfiles.set(key, getProfile());
  }
  return pinnedProfiles.get(key)!;
}

export function clearPinnedProfile(key: string): void {
  pinnedProfiles.delete(key);
}

/**
 * Build full stealth headers for an HTTP request.
 * Includes UA, sec-ch-ua, Accept, Accept-Language.
 * For Firefox profiles, sec-ch-ua headers are omitted (Firefox doesn't send them).
 */
export function getStealthHeaders(profile?: BrowserProfile): Record<string, string> {
  const p = profile ?? getRandomProfile();
  const headers: Record<string, string> = {
    "User-Agent": p.ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };
  // Only add sec-ch-ua headers for Chromium-based profiles
  if (p["sec-ch-ua"]) {
    headers["sec-ch-ua"] = p["sec-ch-ua"];
    headers["sec-ch-ua-platform"] = p["sec-ch-ua-platform"];
    headers["sec-ch-ua-mobile"] = p["sec-ch-ua-mobile"];
  }
  return headers;
}

// --- Per-Domain Rate Limiter (Token Bucket) ---

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_RPM = 30;
const DEFAULT_BURST = 5;

export interface RateLimitConfig {
  /** Requests per minute */
  rpm: number;
  /** Max burst size */
  burst: number;
}

/** Domains with known API access — no rate limiting needed */
const UNLIMITED_DOMAINS = new Set([
  "en.wikipedia.org",
  "api.openalex.org",
  "api.open-meteo.com",
  "www.googleapis.com",
  "api.search.brave.com",
  "api.tavily.com",
]);

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  "html.duckduckgo.com": { rpm: 20, burst: 3 },
  "lite.duckduckgo.com": { rpm: 20, burst: 3 },
  "www.bing.com":        { rpm: 25, burst: 5 },
  "indiankanoon.org":    { rpm: 15, burst: 2 },
  "www.indiacode.nic.in": { rpm: 10, burst: 2 },
  "www.sebi.gov.in":     { rpm: 10, burst: 2 },
  "www.mojeek.com":      { rpm: 20, burst: 3 },
  "news.google.com":     { rpm: 20, burst: 3 },
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /**
   * Acquire a token for the given domain. Resolves immediately if tokens
   * are available, otherwise waits until a token is refilled.
   * Returns immediately for unlimited (API-backed) domains.
   */
  async acquire(domain: string): Promise<void> {
    if (UNLIMITED_DOMAINS.has(domain)) return;

    const config = RATE_LIMITS[domain] ?? { rpm: DEFAULT_RPM, burst: DEFAULT_BURST };
    const refillInterval = 60_000 / config.rpm; // ms between token refills

    if (!this.buckets.has(domain)) {
      this.buckets.set(domain, { tokens: config.burst, lastRefill: Date.now() });
    }

    const bucket = this.buckets.get(domain)!;
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / refillInterval);

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(config.burst, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    // Wait for next token refill
    const waitMs = refillInterval - (now - bucket.lastRefill);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(50, waitMs)));
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }
}

/** Shared rate limiter instance */
export const globalRateLimiter = new RateLimiter();
