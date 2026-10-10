/**
 * SSRF-hardened HTTP client built on node:http/https.
 *
 * Why not global fetch? fetch() resolves DNS internally, so a hostname can pass
 * a pre-flight check and then resolve to 127.0.0.1 at connect time (DNS
 * rebinding). Here, every connection goes through a custom `lookup` that
 * validates the exact IPs the socket will connect to.
 *
 * Guarantees:
 *  - Only http/https; no credentials in URL; private/reserved IPs blocked
 *    (both IP literals and DNS-resolved addresses, on every redirect hop).
 *  - Redirects followed manually (max `maxRedirects`), each hop re-validated.
 *  - Body capped at `maxBytes` AFTER decompression (zip-bomb safe).
 *  - One overall deadline across all hops.
 *  - Honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY (or configureProxy()).
 *
 * Through a proxy, the proxy resolves DNS, so the connect-time pin above
 * cannot apply. Instead the target is resolved locally first and blocked if
 * it maps to a private address; if it cannot be resolved locally (common in
 * locked-down networks where only the proxy has DNS), the request proceeds
 * and the proxy's own egress policy applies.
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import zlib from "node:zlib";
import net from "node:net";
import tls from "node:tls";
import type { LookupFunction } from "node:net";
import { isSsrfSafe, isPrivateAddress } from "./security.js";
import { resolveProxy, openTunnel, connectToProxy, ResolvedProxy } from "./proxy.js";

export interface SafeFetchOptions {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Max decoded body bytes. Default 2 MB. Extra bytes are dropped and `truncated` is set. */
  maxBytes?: number;
  /** Max redirects to follow. Default 5. Set 0 to return 3xx responses as-is. */
  maxRedirects?: number;
  /** Allow private/loopback targets (e.g. a self-hosted SearXNG on localhost). Default false. */
  allowPrivate?: boolean;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  text(): string;
  json(): unknown;
}

export class SsrfError extends Error {
  constructor(reason: string) {
    super(`SSRF blocked: ${reason}`);
    this.name = "SsrfError";
  }
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      return (callback as any)(new SsrfError(`${hostname} resolves to private address ${bad.address}`));
    }
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    const first = list[0];
    return (callback as any)(null, first.address, first.family);
  });
};

function decoderFor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? "").toLowerCase().trim()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function normaliseRequestHeaders(h: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    // Only advertise encodings we can decode.
    if (k.toLowerCase() === "accept-encoding") continue;
    out[k] = v;
  }
  out["Accept-Encoding"] = "gzip, deflate, br";
  return out;
}

/**
 * Pre-flight for proxied requests: resolve locally and refuse private targets.
 * Local resolution failure is tolerated (the proxy may be the only resolver).
 */
async function checkProxiedTarget(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return; // literals were already checked by isSsrfSafe
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return;
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new SsrfError(`${hostname} resolves to private address ${bad.address}`);
}

interface Route {
  /** Where to send the request line (target or proxy). */
  requestUrl: URL;
  /** Absolute-form path for plain-http-through-proxy. */
  path?: string;
  extraHeaders: Record<string, string>;
  createConnection?: () => net.Socket;
  lookup?: LookupFunction;
}

async function planRoute(url: URL, opts: SafeFetchOptions, deadline: number, owned: net.Socket[]): Promise<Route> {
  const proxy: ResolvedProxy | null = resolveProxy(url);
  if (!proxy) {
    return { requestUrl: url, extraHeaders: {}, lookup: opts.allowPrivate ? undefined : guardedLookup };
  }

  if (!opts.allowPrivate) await checkProxiedTarget(url.hostname);

  const targetHost = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "https:") {
    // HTTPS target: CONNECT tunnel, then TLS end-to-end with the target.
    const port = Number(url.port || 443);
    const tunnel = await openTunnel(proxy, targetHost, port, deadline - Date.now());
    const secure = tls.connect({
      socket: tunnel,
      servername: net.isIP(targetHost) ? undefined : targetHost,
      ALPNProtocols: ["http/1.1"],
    });
    secure.on("error", () => {}); // see openTunnel: never an unhandled 'error'
    owned.push(secure, tunnel);
    return { requestUrl: url, extraHeaders: {}, createConnection: () => secure };
  }

  // Plain-HTTP target: absolute-form request line sent to the proxy.
  return {
    requestUrl: proxy.url,
    path: url.toString(),
    extraHeaders: {
      Host: url.host,
      ...(proxy.authorization ? { "Proxy-Authorization": proxy.authorization } : {}),
    },
    createConnection: proxy.url.protocol === "https:"
      ? () => {
          const sock = connectToProxy(proxy);
          sock.on("error", () => {});
          owned.push(sock);
          return sock;
        }
      : undefined,
  };
}

async function singleRequest(
  url: URL,
  opts: SafeFetchOptions,
  deadline: number
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  if (deadline - Date.now() <= 0) throw new Error("Request timed out");
  // Sockets we create for proxying are single-use: destroy them when done.
  const owned: net.Socket[] = [];
  const release = () => { for (const sk of owned) sk.destroy(); };
  let route: Route;
  try {
    route = await planRoute(url, opts, deadline, owned);
  } catch (e) {
    release();
    throw e;
  }

  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error("Request timed out"));

    // The protocol of the hop we actually speak HTTP over.
    const lib = route.createConnection && url.protocol === "https:" ? https
      : route.requestUrl.protocol === "https:" && !route.path ? https
      : http;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const headers = { ...normaliseRequestHeaders(opts.headers), ...route.extraHeaders };
    if (opts.body != null) headers["Content-Length"] = String(Buffer.byteLength(opts.body));

    const req = lib.request(
      {
        protocol: route.path ? "http:" : route.requestUrl.protocol,
        hostname: route.requestUrl.hostname.replace(/^\[|\]$/g, ""),
        port: route.requestUrl.port || undefined,
        path: route.path ?? `${route.requestUrl.pathname}${route.requestUrl.search}`,
        method: opts.method ?? "GET",
        headers,
        servername: !route.path && !net.isIP(route.requestUrl.hostname.replace(/^\[|\]$/g, ""))
          ? route.requestUrl.hostname : undefined,
        ...(route.createConnection ? { createConnection: route.createConnection, agent: false } : {}),
        ...(route.lookup ? { lookup: route.lookup } : {}),
      } as https.RequestOptions,
      (res) => {
        const status = res.statusCode ?? 0;
        // Redirect responses: don't read the body.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          clearTimeout(timer);
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
        }

        const decoder = decoderFor(res.headers["content-encoding"] as string | undefined);
        const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };

        stream.on("data", (chunk: Buffer) => {
          if (done) return;
          const room = maxBytes - size;
          if (chunk.length >= room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = maxBytes;
            truncated = true;
            finish();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new Error("Request timed out"));
    }, remaining);

    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (opts.body != null) req.write(opts.body);
    req.end();
  }).finally(release);
}

/**
 * Fetch a URL with SSRF protection on every hop. Throws SsrfError when a hop
 * targets a blocked address.
 */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = new URL(input.toString());
  let method = opts.method ?? "GET";
  let body = opts.body;
  let redirects = 0;

  while (true) {
    if (!opts.allowPrivate) {
      const check = isSsrfSafe(url.toString());
      if (!check.allowed) throw new SsrfError(check.reason ?? "blocked");
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError(`Blocked scheme: ${url.protocol}`);
    }

    const res = await singleRequest(url, { ...opts, method, body }, deadline);

    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && maxRedirects > 0) {
      if (redirects >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
      redirects++;
      url = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    const finalUrl = url.toString();
    const buf = res.body;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      url: finalUrl,
      redirected: redirects > 0,
      headers: res.headers,
      body: buf,
      truncated: res.truncated,
      text: () => buf.toString("utf8"),
      json: () => JSON.parse(buf.toString("utf8")),
    };
  }
}
