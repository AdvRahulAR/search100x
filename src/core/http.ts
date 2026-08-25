/**
 * Thin wrapper around native fetch. Drops the axios dependency while keeping
 * the { data } response shape that adapters expect.
 *
 * Supports a 3-second default timeout via AbortController, JSON and text
 * response types, and query-string params.
 */

export interface HttpResponse {
  data: any;
}

class HttpError extends Error {
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
): Promise<{ data: any }> {
  const u = new URL(url.toString());
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      u.searchParams.set(k, String(v));
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 10_000);

  try {
    const res = await fetch(u.toString(), {
      method,
      headers: opts.headers,
      body: opts.body != null
        ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body))
        : undefined,
      signal: ctrl.signal,
      redirect: "follow",
    });

    // Detect redirects — useful for debugging CAPTCHA/bot-detection walls
    // that return 302 redirects instead of blocking outright.
    if (res.redirected) {
      // Silently note — log via console.warn so it appears in debug but doesn't break
      const originalHost = u.hostname;
      const finalHost = new URL(res.url).hostname;
      if (originalHost !== finalHost) {
        console.warn(`[search100x] ${method} ${originalHost} redirected to ${finalHost} — possible bot detection`);
      }
    }

    if (!res.ok) throw new HttpError(res.status);

    const data =
      opts.responseType === "text" ? await res.text() : await res.json();
    return { data };
  } finally {
    clearTimeout(timer);
  }
}

export const http = {
  get: (url: string | URL, opts?: Parameters<typeof request>[2]) =>
    request("GET", url, opts),
  post: (url: string | URL, body: unknown, opts?: Parameters<typeof request>[2]) =>
    request("POST", url, { ...opts, body }),
};
