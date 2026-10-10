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

import net from "node:net";
import dns from "node:dns";

// Private / reserved / non-routable ranges. Checked with net.BlockList so that
// every textual form of an address (compressed IPv6, mapped IPv4, …) is handled.
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],        // "this" network
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local / cloud metadata
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved + broadcast
];
const BLOCKED_V6: Array<[string, number]> = [
  ["::", 128],           // unspecified
  ["::1", 128],          // loopback
  ["fc00::", 7],         // unique-local
  ["fe80::", 10],        // link-local
  ["fec0::", 10],        // deprecated site-local
  ["ff00::", 8],         // multicast
  ["100::", 64],         // discard-only
  ["2001:db8::", 32],    // documentation
];

const blockList = new net.BlockList();
for (const [a, p] of BLOCKED_V4) blockList.addSubnet(a, p, "ipv4");
for (const [a, p] of BLOCKED_V6) blockList.addSubnet(a, p, "ipv6");

/** Extract an embedded IPv4 from IPv4-mapped/compatible, NAT64 or 6to4 IPv6 addresses. */
function embeddedV4(ip6: string): string | null {
  const lower = ip6.toLowerCase();
  // Dotted forms: ::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4
  const dotted = lower.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && (lower.startsWith("::") || lower.startsWith("64:ff9b:"))) return dotted[1];
  // Hex forms: ::ffff:7f00:1, 64:ff9b::7f00:1
  const hex = lower.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // 6to4: 2002:AABB:CCDD::
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16), lo = parseInt(sixToFour[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when an IP address (v4 or v6, any textual form) is private, loopback, link-local or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(addr);
  if (family === 4) return blockList.check(addr, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(addr);
    if (v4 && net.isIP(v4) === 4 && blockList.check(v4, "ipv4")) return true;
    return blockList.check(addr, "ipv6");
  }
  return false;
}

// Blocked hostnames (after trailing-dot removal)
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);
// Blocked suffixes — internal-only DNS namespaces
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

// Blocked URL schemes — only http/https allowed
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Synchronous URL-level SSRF check: scheme, credentials, internal hostnames and
 * IP literals in every encoding. This cannot see what a hostname resolves to —
 * use `safeFetch()` (which validates resolved IPs at connect time) for requests.
 */
export function isSsrfSafe(url: string): SsrfCheckResult {
  try {
    const parsed = new URL(url);

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` };
    }

    if (parsed.username || parsed.password) {
      return { allowed: false, reason: "URL with credentials not allowed" };
    }

    // Strip IPv6 brackets and any trailing dots ("localhost." == "localhost").
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

    if (!hostname) {
      return { allowed: false, reason: "Empty hostname" };
    }

    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      return { allowed: false, reason: `Blocked hostname: ${hostname}` };
    }

    // WHATWG URL already normalises decimal/octal/hex IPv4 (e.g. 2130706433 -> 127.0.0.1).
    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) {
        return { allowed: false, reason: `Blocked IP range: ${hostname}` };
      }
    } else if (!hostname.includes(".")) {
      // Single-label names resolve via local search domains — never public.
      return { allowed: false, reason: `Blocked single-label hostname: ${hostname}` };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
}

/**
 * Resolve a hostname and throw if any address is private. Used where we cannot
 * pin the connection (e.g. a headless browser). Residual DNS-rebinding risk
 * remains there; HTTP fetches use safeFetch(), which pins resolved IPs.
 */
export async function assertResolvesPublic(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`SSRF blocked: ${host} is a private address`);
    return;
  }
  const addrs = await dns.promises.lookup(host, { all: true });
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`SSRF blocked: ${host} resolves to private address ${bad.address}`);
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
