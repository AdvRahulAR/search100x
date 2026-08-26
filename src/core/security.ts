/**
 * SSRF (Server-Side Request Forgery) protection.
 *
 * Phase 5: Security
 * ──────────────────
 * Blocks requests to private/internal IP ranges, localhost, link-local,
 * and other non-public addresses. Prevents the search enricher from
 * being used as a proxy to access internal services.
 *
 * Also provides redirect validation — ensures redirect targets don't
 * point to private addresses after following redirects.
 */

// Private/internal IP ranges (CIDR)
const BLOCKED_IP_PATTERNS: RegExp[] = [
  // IPv4 private ranges
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  // Loopback
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  // Link-local
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  // Reserved
  /^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^255\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  // Carrier-grade NAT
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,
  // IPv6 loopback
  /^::1$/,
  // IPv6 link-local
  /^fe80::/i,
  // IPv6 unique-local
  /^f[cd][0-9a-f]{2}:/i,
  // IPv6 multicast
  /^ff[0-9a-f]{2}:/i,
];

// Blocked hostnames
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

// Blocked URL schemes — only http/https allowed
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a URL for SSRF safety.
 * Checks scheme, hostname, and attempts to detect private IP literals.
 */
export function isSsrfSafe(url: string): SsrfCheckResult {
  try {
    const parsed = new URL(url);

    // Check scheme
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check blocked hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { allowed: false, reason: `Blocked hostname: ${hostname}` };
    }

    // Check for IP literals in hostname
    // Strip IPv6 brackets
    const ipLiteral = hostname.replace(/^\[|\]$/g, "");

    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(ipLiteral)) {
        return { allowed: false, reason: `Blocked IP range: ${ipLiteral}` };
      }
    }

    // Check for decimal/octal IP encoding (e.g. 0x7f.0x0.0x0.0x1)
    if (/^\d+$/.test(ipLiteral) || /^0x[0-9a-f]+/i.test(ipLiteral)) {
      return { allowed: false, reason: `Blocked encoded IP: ${ipLiteral}` };
    }

    // Check for @ sign (userinfo) — could be used to bypass
    if (parsed.username || parsed.password) {
      return { allowed: false, reason: "URL with credentials not allowed" };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
}

/**
 * Validate a redirect chain — ensure the final destination is SSRF-safe.
 */
export function isRedirectSafe(originalUrl: string, finalUrl: string): SsrfCheckResult {
  const originalCheck = isSsrfSafe(originalUrl);
  if (!originalCheck.allowed) return originalCheck;

  const finalCheck = isSsrfSafe(finalUrl);
  if (!finalCheck.allowed) {
    return {
      allowed: false,
      reason: `Redirect to blocked target: ${finalCheck.reason}`,
    };
  }

  return { allowed: true };
}

/**
 * Prompt injection marker — detect attempts to inject instructions
 * in fetched web content that could manipulate the LLM.
 *
 * Looks for common prompt injection patterns in extracted text:
 * - "Ignore all previous instructions"
 * - "You are now a..." / "Act as..."
 * - System/assistant role markers
 * - Hidden instruction patterns
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+a\s+(different|new)/i,
  /act\s+as\s+(if|a|an)\s/i,
  /system\s*:\s*(respond|output|ignore)/i,
  /assistant\s*:\s*(ignore|forget|override)/i,
  /\[INST\]|\[\/INST\]/i,
  /<\|im_start\|>|<\|system\|>/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions?|context)/i,
  /reveal\s+(your|the)\s+(system|hidden|secret)\s+prompt/i,
];

export interface InjectionCheckResult {
  safe: boolean;
  pattern?: string;
}

export function detectPromptInjection(text: string): InjectionCheckResult {
  // Only check first 5000 chars — injection usually at the start
  const sample = text.slice(0, 5000);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sample)) {
      return { safe: false, pattern: pattern.source };
    }
  }
  return { safe: true };
}

/**
 * Bloom filter for URL-based deduplication.
 * Probabilistic set membership — false positives possible but no false negatives.
 * Used to quickly check if a URL has already been fetched.
 */
export class BloomFilter {
  private bits: Uint8Array;
  private readonly size: number;
  private readonly hashCount: number;

  constructor(size = 10_000, hashCount = 4) {
    this.size = size;
    this.hashCount = hashCount;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }

  private hash(str: string, seed: number): number {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % this.size;
  }

  add(item: string): void {
    for (let i = 0; i < this.hashCount; i++) {
      const idx = this.hash(item, i);
      this.bits[Math.floor(idx / 8)] |= (1 << (idx % 8));
    }
  }

  contains(item: string): boolean {
    for (let i = 0; i < this.hashCount; i++) {
      const idx = this.hash(item, i);
      if (!(this.bits[Math.floor(idx / 8)] & (1 << (idx % 8)))) {
        return false;
      }
    }
    return true;
  }

  clear(): void {
    this.bits.fill(0);
  }

  get bitCount(): number {
    let count = 0;
    for (const byte of this.bits) {
      let v = byte;
      while (v) { v &= v - 1; count++; }
    }
    return count;
  }
}

/**
 * Lost-in-the-middle reranking.
 *
 * LLMs pay most attention to the beginning and end of context windows,
 * with reduced attention in the middle. This function reorders results
 * to place the most relevant at the edges (positions 0, N-1, 1, N-2, ...).
 */
export function lostInTheMiddleRerank<T extends { score?: number }>(
  results: T[],
  threshold = 6
): T[] {
  if (results.length <= threshold) return results;

  // Sort by score descending (if scores exist)
  const sorted = [...results].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0)
  );

  // Interleave: best at edges, worst in middle
  // Position 0 gets the best, position N-1 gets 2nd best,
  // position 1 gets 3rd best, position N-2 gets 4th best, etc.
  const reordered: T[] = new Array(sorted.length);
  let left = 0;
  let right = sorted.length - 1;
  let toggle = true;

  for (let i = 0; i < sorted.length; i++) {
    if (toggle) {
      reordered[left++] = sorted[i];
    } else {
      reordered[right--] = sorted[i];
    }
    toggle = !toggle;
  }

  return reordered;
}
