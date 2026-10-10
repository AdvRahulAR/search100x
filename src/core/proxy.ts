/**
 * Outbound proxy support (HTTP/HTTPS proxies, as used in corporate networks).
 *
 * Resolution order for each request:
 *   1. configureProxy({ url: false })   → never proxy
 *   2. configureProxy({ url: "http://…" }) → use that proxy
 *   3. Environment: HTTPS_PROXY / https_proxy for https targets,
 *      HTTP_PROXY / http_proxy for http targets, ALL_PROXY / all_proxy as fallback.
 * NO_PROXY / no_proxy (or configureProxy({ noProxy })) bypasses the proxy for
 * matching hosts. Supported entries: "*", "example.com" (and subdomains),
 * ".example.com", "*.example.com", "host:port", IPv4/IPv6 literals and CIDRs.
 *
 * Proxy credentials go in the URL: http://user:pass@proxy.corp:8080
 * (sent as Proxy-Authorization: Basic). SOCKS proxies are not supported.
 */

import net from "node:net";
import tls from "node:tls";

export interface ProxySettings {
  /** Proxy URL, or `false` to disable proxying (including env vars). */
  url?: string | false;
  /** Comma-separated or array NO_PROXY list. Defaults to NO_PROXY / no_proxy env. */
  noProxy?: string | string[];
}

let settings: ProxySettings = {};

/**
 * Configure the proxy used by every outbound request in this process.
 * Call with `{}` to go back to environment-variable behaviour.
 */
export function configureProxy(next: ProxySettings): void {
  if (typeof next.url === "string") parseProxyUrl(next.url); // validate early
  settings = { ...next };
}

/** Current explicit settings (env vars are read per request). */
export function getProxySettings(): ProxySettings {
  return { ...settings };
}

export interface ResolvedProxy {
  url: URL;
  /** Value for the Proxy-Authorization header, if credentials were given. */
  authorization?: string;
}

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function parseProxyUrl(raw: string): URL {
  // Accept "proxy.corp:8080" as shorthand for http://proxy.corp:8080
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`search100x: unsupported proxy protocol "${u.protocol}" (only http:// and https:// proxies are supported)`);
  }
  return u;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** True when `target` should bypass the proxy according to a NO_PROXY list. */
export function matchesNoProxy(target: URL, noProxy: string | string[] | undefined): boolean {
  if (!noProxy) return false;
  const entries = (Array.isArray(noProxy) ? noProxy : noProxy.split(/[\s,]+/))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;

  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const port = target.port || defaultPort(target.protocol);
  const ipFamily = net.isIP(host);

  for (const entry of entries) {
    if (entry === "*") return true;

    // CIDR (IPv4 or IPv6)
    const cidr = entry.match(/^\[?([0-9a-f.:]+)\]?\/(\d{1,3})$/i);
    if (cidr) {
      if (!ipFamily) continue;
      const fam = net.isIP(cidr[1]);
      if (!fam || fam !== ipFamily) continue;
      const bl = new net.BlockList();
      try {
        bl.addSubnet(cidr[1], Number(cidr[2]), fam === 4 ? "ipv4" : "ipv6");
        if (bl.check(host, fam === 4 ? "ipv4" : "ipv6")) return true;
      } catch {
        /* malformed entry — ignore */
      }
      continue;
    }

    // Optional :port suffix (not for bare IPv6)
    let name = entry;
    let entryPort: string | undefined;
    const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) {
      name = bracketed[1];
      entryPort = bracketed[2];
    } else if (!net.isIP(entry)) {
      const m = entry.match(/^(.*):(\d+)$/);
      if (m) {
        name = m[1];
        entryPort = m[2];
      }
    }
    if (entryPort && entryPort !== port) continue;

    if (net.isIP(name)) {
      if (ipFamily && name === host) return true;
      continue;
    }
    const suffix = name.replace(/^\*?\./, "");
    if (host === suffix || host.endsWith("." + suffix)) return true;
  }
  return false;
}

/** Decide which proxy (if any) to use for `target`. */
export function resolveProxy(target: URL): ResolvedProxy | null {
  if (settings.url === false) return null;

  const noProxy = settings.noProxy ?? env("NO_PROXY", "no_proxy");
  if (matchesNoProxy(target, noProxy)) return null;

  const raw = typeof settings.url === "string"
    ? settings.url
    : target.protocol === "https:"
      ? env("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
      : env("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (!raw) return null;

  let url: URL;
  try {
    url = parseProxyUrl(raw);
  } catch {
    // An unusable env value (e.g. socks5://) must not break direct requests.
    return null;
  }

  let authorization: string | undefined;
  if (url.username || url.password) {
    const creds = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
  }
  return { url, authorization };
}

/** Open a TCP (or TLS, for https:// proxies) connection to the proxy itself. */
export function connectToProxy(proxy: ResolvedProxy): net.Socket {
  const port = Number(proxy.url.port || defaultPort(proxy.url.protocol));
  const host = proxy.url.hostname.replace(/^\[|\]$/g, "");
  return proxy.url.protocol === "https:"
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
    : net.connect({ host, port });
}

/**
 * Establish an HTTP CONNECT tunnel through `proxy` to `host:port`.
 * Resolves with the raw tunnelled socket (wrap it in TLS for https targets).
 */
export function openTunnel(
  proxy: ResolvedProxy,
  host: string,
  port: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectToProxy(proxy);
    const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error(`Proxy CONNECT to ${authority} timed out`)), Math.max(1, timeoutMs));

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > 16 * 1024) fail(new Error("Proxy CONNECT response too large"));
        return;
      }
      socket.removeListener("data", onData);
      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 200) {
        fail(new Error(`Proxy CONNECT to ${authority} failed: ${statusLine}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Late resets on an idle/finished tunnel must never crash the process;
      // in-flight errors still reach the HTTP request's own listeners.
      socket.on("error", () => {});
      // Bytes after the header belong to the tunnel (rare before we speak first).
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.on("data", onData);
    socket.once("error", (e) => fail(e));
    socket.once("close", () => fail(new Error(`Proxy closed connection during CONNECT to ${authority}`)));

    const ready = proxy.url.protocol === "https:" ? "secureConnect" : "connect";
    socket.once(ready, () => {
      const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        ...(proxy.authorization ? [`Proxy-Authorization: ${proxy.authorization}`] : []),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
  });
}
