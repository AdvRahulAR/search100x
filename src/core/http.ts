/**
 * Thin wrapper around native fetch. Drops the axios dependency while keeping
 * the { data } response shape that adapters expect.
 *
 * Supports a 3-second default timeout via AbortController, JSON and text
 * response types, and query-string params.
 */

import { safeFetch } from "./safe-fetch.js";

export interface HttpResponse {
  data: unknown;
}

export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** Upper bound on any server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 5_000;

async function request(
  method: "GET" | "POST",
  url: string | URL,
  opts: {
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    responseType?: "text" | "json";
    /** Max decoded response bytes (default 2 MB). */
    maxBytes?: number;
    /** Permit private/loopback targets — only for user-configured hosts (e.g. self-hosted SearXNG). */
    allowPrivate?: boolean;
  } = {}
): Promise<{ data: unknown }> {
  const u = new URL(url.toString());
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      u.searchParams.set(k, String(v));
    }
  }

  let finalBody: string | undefined;
  if (opts.body != null) {
    if (typeof opts.body === "string") {
      finalBody = opts.body;
    } else {
      const isUrlEncoded = Object.entries(opts.headers ?? {}).some(
        ([k, v]) => k.toLowerCase() === "content-type" && v.toLowerCase().includes("application/x-www-form-urlencoded")
      );
      finalBody = isUrlEncoded
        ? new URLSearchParams(opts.body as Record<string, string>).toString()
        : JSON.stringify(opts.body);
    }
  }

  const timeoutMs = opts.timeout ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const maxRetries = 2;
  const backoffs = [500, 1500];

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Request timed out");

    // safeFetch validates scheme, IP literals, resolved IPs (at connect time)
    // and every redirect hop; it also caps the body size.
    const res = await safeFetch(u, {
      method,
      headers: opts.headers,
      body: finalBody,
      timeoutMs: remaining,
      maxBytes: opts.maxBytes,
      allowPrivate: opts.allowPrivate,
    });

    if (res.redirected && process.env.DEBUG) {
      const finalHost = new URL(res.url).hostname;
      if (finalHost !== u.hostname) {
        console.warn(`[search100x] ${method} ${u.hostname} redirected to ${finalHost} — possible bot detection`);
      }
    }

    if (!res.ok) {
      if ([429, 503, 408].includes(res.status) && attempt < maxRetries) {
        let waitTime = backoffs[attempt];
        const retryAfter = res.headers["retry-after"];
        const parsed = typeof retryAfter === "string" ? parseInt(retryAfter, 10) : NaN;
        if (!isNaN(parsed) && parsed >= 0) waitTime = parsed * 1000;
        // Never sleep longer than the cap or past the caller's deadline.
        waitTime = Math.min(waitTime, MAX_RETRY_AFTER_MS, Math.max(0, deadline - Date.now() - 100));
        if (waitTime <= 0) throw new HttpError(res.status);
        await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      throw new HttpError(res.status);
    }

    const data = opts.responseType === "text" ? res.text() : res.json();
    return { data };
  }
}

export const http = {
  get: (url: string | URL, opts?: Parameters<typeof request>[2]) =>
    request("GET", url, opts),
  post: (url: string | URL, body: unknown, opts?: Parameters<typeof request>[2]) =>
    request("POST", url, { ...opts, body }),
};

// Re-export SSRF guard for convenience
export { isSsrfSafe } from "./security.js";
