/**
 * Thin wrapper around native fetch. Drops the axios dependency while keeping
 * the { data } response shape that all adapters expect.
 *
 * Throws HttpError (with .response.status) on non-2xx — matches the subset of
 * AxiosError that adapters actually check (wikipedia retry uses status === 429).
 */

export class HttpError extends Error {
  response: { status: number };
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.response = { status };
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

    if (!res.ok) throw new HttpError(res.status);

    const data =
      opts.responseType === "text" ? await res.text() : await res.json();
    return { data };
  } finally {
    clearTimeout(timer);
  }
}

export const http = {
  get: (
    url: string | URL,
    opts: Omit<Parameters<typeof request>[2], "body"> = {}
  ) => request("GET", url, opts),

  post: (
    url: string,
    body: unknown,
    opts: Omit<Parameters<typeof request>[2], "body" | "params"> = {}
  ) => request("POST", url, { ...opts, body }),
};
