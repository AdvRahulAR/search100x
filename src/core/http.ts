/**
 * Thin wrapper around native fetch. Drops the axios dependency while keeping
 * the { data } response shape that adapters expect.
 *
 * Supports a 3-second default timeout via AbortController, JSON and text
 * response types, and query-string params.
 */

import { isSsrfSafe } from "./security.js";

export interface HttpResponse {
  data: unknown;
}

export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function request(
  method: "GET" | "POST",
  url: string | URL,
  opts: {
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
    responseType?: "text" | "json";
  } = {}
): Promise<{ data: unknown }> {
  const u = new URL(url.toString());
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      u.searchParams.set(k, String(v));
    }
  }

  const ssrfCheck = isSsrfSafe(u.toString());
  if (!ssrfCheck.allowed) {
    throw new Error(`SSRF blocked: ${ssrfCheck.reason}`);
  }

  let attempt = 0;
  const maxRetries = 2;
  const backoffs = [500, 1500];

  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 10_000);

    try {
      let finalBody: BodyInit | undefined;
      if (opts.body != null) {
        if (typeof opts.body === "string") {
          finalBody = opts.body;
        } else {
          // Check for x-www-form-urlencoded
          let isUrlEncoded = false;
          if (opts.headers) {
            for (const [k, v] of Object.entries(opts.headers)) {
              if (k.toLowerCase() === "content-type" && v.toLowerCase().includes("application/x-www-form-urlencoded")) {
                isUrlEncoded = true;
                break;
              }
            }
          }
          if (isUrlEncoded) {
            finalBody = new URLSearchParams(opts.body as Record<string, string>).toString();
          } else {
            finalBody = JSON.stringify(opts.body);
          }
        }
      }

      const res = await fetch(u.toString(), {
        method,
        headers: opts.headers,
        body: finalBody,
        signal: ctrl.signal,
        redirect: "follow",
      });

      // Detect redirects — useful for debugging CAPTCHA/bot-detection walls
      // that return 302 redirects instead of blocking outright.
      if (res.redirected) {
        // Silently note — log via console.warn so it appears in debug but doesn't break
        const originalHost = u.hostname;
        const finalHost = new URL(res.url).hostname;
        if (originalHost !== finalHost && process.env.DEBUG) {
          console.warn(`[search100x] ${method} ${originalHost} redirected to ${finalHost} — possible bot detection`);
        }
      }

      if (!res.ok) {
        if ([429, 503, 408].includes(res.status) && attempt < maxRetries) {
          let waitTime = backoffs[attempt];
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
              waitTime = parsed * 1000;
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
          attempt++;
          continue; // retry
        }
        throw new HttpError(res.status);
      }

      const data =
        opts.responseType === "text" ? await res.text() : await res.json();
      return { data };
    } catch (e: unknown) {
      throw e; // We only retry on HTTP status codes as requested
    } finally {
      clearTimeout(timer);
    }
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
