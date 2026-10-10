/**
 * Offline regression tests for the v4.3.1 security & correctness fixes.
 * No network access: engines are mocked via the plugin API, and HTTP targets
 * are local servers.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import net from "node:net";
import {
  EnhancedSearch, isSsrfSafe, isPrivateAddress, safeFetch, fetchPageContent,
  buildCitedQuery, toDocuments, citationSources, cacheKey, ResultCache, SearXNGEngine,
  configureProxy, resolveProxy, matchesNoProxy,
} from "../../dist/index.js";
import { createMicroServer } from "../../dist/micro-server.js";

const BUILTINS = [
  "duckduckgo", "bing", "mojeek", "googlenews", "bingnews", "wikipedia", "openalex", "brave",
  "tavily", "google", "searxng", "marginalia", "yep", "openmeteo", "indiacode", "sebi",
  "indiankanoon", "startpage", "hackernews", "github", "arxiv",
];

function mock(name, rows) {
  return {
    name,
    calls: [],
    async search(q) {
      this.calls.push(q);
      return rows.map(([url, title, snippet]) => ({ url, title, snippet: snippet ?? title }));
    },
  };
}

function isolated(engines, cfg = {}) {
  const s = new EnhancedSearch({ timeoutMs: 3000, logger: { warn() {}, log() {} }, ...cfg });
  BUILTINS.forEach((n) => s.remove(n));
  engines.forEach((e) => s.use(e));
  return s;
}

const OPTS = { noEarlyReturn: true, noCache: true };

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ── SearXNG opt-in ──────────────────────────────────────────────────────────

describe("SearXNG is opt-in", () => {
  it("is not registered without a baseUrl", () => {
    const prev = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    try {
      const s = new EnhancedSearch();
      assert.ok(!("searxng" in s.metrics()), "searxng must not be active by default");
    } finally {
      if (prev !== undefined) process.env.SEARXNG_URL = prev;
    }
  });

  it("refuses to construct without a baseUrl", () => {
    const prev = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    try {
      assert.throws(() => new SearXNGEngine({}));
    } finally {
      if (prev !== undefined) process.env.SEARXNG_URL = prev;
    }
  });

  it("does not mutate the caller's config and sends no default token", async () => {
    const seen = [];
    const srv = await listen((req, res) => {
      seen.push(req.headers.authorization ?? null);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ url: "https://a.example/x", title: "A", content: "a" }] }));
    });
    const cfg = { baseUrl: `http://127.0.0.1:${srv.address().port}` };
    const eng = new SearXNGEngine(cfg);
    const out = await eng.search("q", 3000);
    srv.close();
    assert.equal(out.length, 1, "self-hosted instance on localhost must be allowed");
    assert.deepEqual(seen, [null], "no Authorization header without a configured token");
    assert.deepEqual(Object.keys(cfg), ["baseUrl"], "config object must not be mutated");
  });
});

// ── SSRF ────────────────────────────────────────────────────────────────────

describe("SSRF guard", () => {
  const blocked = [
    "http://127.0.0.1/", "http://localhost./", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://[::]/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://2130706433/",
    "http://0x7f.1/", "http://metadata.google.internal/", "http://foo.localhost/", "http://intranet/",
    "http://10.1.2.3/", "http://[fd00::1]/", "http://[64:ff9b::a9fe:a9fe]/", "file:///etc/passwd",
    "http://user:pw@example.com/",
  ];
  for (const u of blocked) {
    it(`blocks ${u}`, () => assert.equal(isSsrfSafe(u).allowed, false));
  }
  it("allows public hosts and IPs", () => {
    assert.equal(isSsrfSafe("https://example.com/a").allowed, true);
    assert.equal(isSsrfSafe("https://[2606:4700::1111]/").allowed, true);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
  });

  it("Google News pattern in a query string cannot bypass the guard", async () => {
    let hits = 0;
    const srv = await listen((_req, res) => { hits++; res.end("<p>secret</p>"); });
    const url = `http://127.0.0.1:${srv.address().port}/?x=news.google.com/rss/articles/abc`;
    await fetchPageContent(url, 2000);
    srv.close();
    assert.equal(hits, 0);
  });

  it("safeFetch rejects private targets and caps decompressed bodies", async () => {
    await assert.rejects(() => safeFetch("http://127.0.0.1:1/"), /SSRF blocked/);
    const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(bomb);
    });
    const res = await safeFetch(`http://127.0.0.1:${srv.address().port}/`, { allowPrivate: true, maxBytes: 100_000 });
    srv.close();
    assert.equal(res.body.length, 100_000);
    assert.equal(res.truncated, true);
  });
});

// ── Cache ───────────────────────────────────────────────────────────────────

describe("cache correctness", () => {
  it("never serves one request's results for a different request", async () => {
    let n = 0;
    const dyn = {
      name: "duckduckgo",
      async search(q) { n++; return [{ url: `https://ex.com/${encodeURIComponent(q)}/${n}`, title: q, snippet: q }]; },
    };
    const s = isolated([dyn]);
    const urls = async (q, o = {}) => (await s.search(q, { noEarlyReturn: true, ...o })).results.map((r) => r.url).join("|");

    assert.notEqual(await urls("डेटा संरक्षण अधिनियम"), await urls("भारतीय दंड संहिता धारा 420"));
    assert.notEqual(await urls("RBI repo rate decision"), await urls("RBI repo rate decision 2024"));
    assert.notEqual(await urls("GDPR erasure", { page: 1 }), await urls("GDPR erasure", { page: 2 }));
    assert.notEqual(await urls("SEC enforcement", { timeRange: "year" }), await urls("SEC enforcement", { timeRange: "day" }));

    const before = n;
    const again = await s.search("RBI repo rate decision", { noEarlyReturn: true });
    assert.equal(n, before, "identical request should hit the cache");
    assert.equal(again.cached, true);
  });

  it("key covers limit and enrichment, ignores option order", () => {
    const a = cacheKey("q", ["x"], { limit: 3, page: 1 });
    assert.notEqual(a, cacheKey("q", ["x"], { limit: 10, page: 1 }));
    assert.notEqual(a, cacheKey("q", ["x"], { limit: 3, page: 1, enrichContent: 2 }));
    assert.equal(a, cacheKey("q", ["x"], { page: 1, limit: 3 }));
  });

  it("is bounded (LRU)", () => {
    const c = new ResultCache(60_000, 3);
    for (let i = 0; i < 10; i++) c.set(`k${i}`, []);
    assert.equal(c.size, 3);
    assert.equal(c.get("k0"), undefined);
    assert.deepEqual(c.get("k9"), []);
  });
});

// ── Ranking / results ───────────────────────────────────────────────────────

describe("results", () => {
  it("scopedDomains strictly restricts results (subdomains allowed)", async () => {
    const rows = [
      ["https://randomblog.com/sec43a", "Section 43A blog"],
      ["https://indiacode.nic.in/x", "Section 43A IT Act"],
      ["https://www.sub.indiacode.nic.in/y", "Section 43A text"],
      ["https://quora.com/q", "Section 43A quora"],
    ];
    const r = await isolated([mock("duckduckgo", rows)]).search("Section 43A", { ...OPTS, scopedDomains: ["indiacode.nic.in"] });
    assert.ok(r.results.length >= 1);
    for (const x of r.results) assert.match(new URL(x.url).hostname, /indiacode\.nic\.in$/);

    const boosted = await isolated([mock("duckduckgo", rows)]).search("Section 43A", { ...OPTS, scopedDomains: ["indiacode.nic.in"], scopeMode: "boost" });
    assert.ok(boosted.results.some((x) => x.url.includes("quora.com")));
  });

  it("does not collapse distinct short URLs on one domain", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => [`https://indiankanoon.org/doc/${1000 + i}/`, `Judgment ${i}`, `Snippet ${i}`]);
    const r = await isolated([mock("duckduckgo", rows)]).search("privacy judgment", OPTS);
    assert.equal(r.results.length, 5);
  });

  it("survives a plugin that throws synchronously", async () => {
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);
    const bad = { name: "badengine", search() { throw new Error("sync boom"); } };
    const t = Date.now();
    const r = await isolated([mock("myengine", [["https://a.com/1", "alpha"]]), bad]).search("alpha", OPTS);
    await new Promise((res) => setTimeout(res, 20));
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unhandled, 0);
    assert.ok(Date.now() - t < 2500, "must not wait for the full timeout");
    assert.equal(r.results.length, 1);
    assert.equal(r.engines.badengine.ok, false);
    assert.match(r.engines.badengine.error, /sync boom/);
  });

  it("reports per-engine errors when everything fails", async () => {
    const failing = { name: "bing", async search() { throw new Error("HTTP 403"); } };
    const r = await isolated([failing]).search("anything", OPTS);
    assert.equal(r.count, 0);
    assert.equal(r.engines.bing.ok, false);
    assert.match(r.engines.bing.error, /403/);
  });

  for (const bad of ["abc", NaN, 0, 5.5, 101]) {
    it(`rejects limit=${String(bad)}`, async () => {
      await assert.rejects(() => isolated([]).search("x", { ...OPTS, limit: bad }), /limit must be an integer/);
    });
  }
});

// ── Citations ───────────────────────────────────────────────────────────────

describe("citations", () => {
  const results = [
    { title: "Doc A", url: "https://a.gov/x", snippet: "A says X.", score: 0.9, sources: ["bing"], content: "A says X in detail." },
    { title: "Empty", url: "https://e.com", snippet: "", score: 0.5, sources: ["bing"] },
    { title: "Doc C", url: "https://c.gov", snippet: "C says Y.", score: 0.4, sources: ["bing"] },
  ];

  it("keeps cited text clean and maps document_index to URLs", () => {
    const docs = toDocuments(results);
    assert.equal(docs[0].source.data, "A says X in detail.");
    const src = citationSources(results);
    assert.deepEqual(src.map((s) => s.url), ["https://a.gov/x", "https://c.gov"]);
    assert.equal(src[1].documentIndex, 1);
    assert.equal(src[1].resultIndex, 2);
  });

  it("buildCitedQuery: configurable max_tokens and untrusted-content system prompt", () => {
    const p = buildCitedQuery(results, "What?", { maxTokens: 2048 });
    assert.equal(p.max_tokens, 2048);
    assert.match(p.system, /untrusted/);
    assert.equal(buildCitedQuery(results, "What?", { system: "" }).system, undefined);
  });

  it("still wraps content in markers when citations are disabled", () => {
    const docs = toDocuments(results, { citations: false });
    assert.match(docs[0].source.data, /WEB_CONTENT_START/);
  });
});

// ── Micro-server ────────────────────────────────────────────────────────────

describe("micro-server hardening", () => {
  let srv, base;
  before(async () => {
    const { server, search } = createMicroServer({ apiKey: "s3cret", rateLimitPerMinute: 3, quiet: true });
    BUILTINS.forEach((n) => search.remove(n));
    srv = server;
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  it("requires the API key (health exempt) and rate limits", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/presets`)).status, 401);
    const auth = { headers: { authorization: "Bearer s3cret" } };
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/presets`, auth)).status);
    // The unauthorised request above doesn't count; 3 allowed, 4th limited.
    assert.deepEqual(codes, [200, 200, 200, 429]);
  });
});

// ── Proxy support ───────────────────────────────────────────────────────────




describe("proxy support", () => {
  let proxy, proxyUrl;
  const seen = [];

  before(async () => {
    // Minimal forward proxy: requires Basic auth; answers absolute-form HTTP
    // requests itself and rejects/accepts CONNECT based on the target host.
    proxy = http.createServer((req, res) => {
      seen.push({ kind: "http", line: `${req.method} ${req.url}`, auth: req.headers["proxy-authorization"], host: req.headers.host });
      if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("alice:s3cret").toString("base64")}`) {
        res.writeHead(407, { "proxy-authenticate": "Basic" });
        return res.end();
      }
      res.end(`proxied ${req.url}`);
    });
    proxy.on("connect", (req, socket) => {
      seen.push({ kind: "connect", line: `CONNECT ${req.url}`, auth: req.headers["proxy-authorization"] });
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://alice:s3cret@127.0.0.1:${proxy.address().port}`;
  });
  after(() => {
    configureProxy({});
    proxy.close();
  });

  it("matches NO_PROXY entries", () => {
    const list = "localhost,.svc.local,*.corp.example,internal.example:8443,10.0.0.0/8,[::1]";
    const m = (u) => matchesNoProxy(new URL(u), list);
    assert.equal(m("http://a.svc.local/"), true);
    assert.equal(m("http://svc.local/"), true);
    assert.equal(m("http://x.corp.example/"), true);
    assert.equal(m("https://internal.example:8443/"), true);
    assert.equal(m("https://internal.example/"), false);
    assert.equal(m("http://10.2.3.4/"), true);
    assert.equal(m("http://[::1]/"), true);
    assert.equal(m("https://example.com/"), false);
    assert.equal(matchesNoProxy(new URL("https://anything.example/"), "*"), true);
  });

  it("sends plain-HTTP requests in absolute form with Proxy-Authorization", async () => {
    configureProxy({ url: proxyUrl, noProxy: "" });
    seen.length = 0;
    const res = await safeFetch("http://public.test.example/path?q=1", { timeoutMs: 3000 });
    assert.equal(res.status, 200);
    assert.equal(res.text(), "proxied http://public.test.example/path?q=1");
    assert.equal(seen[0].line, "GET http://public.test.example/path?q=1");
    assert.equal(seen[0].host, "public.test.example");
    assert.match(seen[0].auth, /^Basic /);
  });

  it("tunnels HTTPS with CONNECT and surfaces proxy refusals clearly", async () => {
    configureProxy({ url: proxyUrl, noProxy: "" });
    seen.length = 0;
    await assert.rejects(
      () => safeFetch("https://blocked.test.example/x", { timeoutMs: 3000 }),
      /Proxy CONNECT to blocked\.test\.example:443 failed: HTTP\/1\.1 403/
    );
    assert.equal(seen[0].line, "CONNECT blocked.test.example:443");
    assert.match(seen[0].auth, /^Basic /);
  });

  it("still applies SSRF rules before anything reaches the proxy", async () => {
    configureProxy({ url: proxyUrl, noProxy: "" });
    seen.length = 0;
    await assert.rejects(() => safeFetch("http://169.254.169.254/latest/meta-data/"), /SSRF blocked/);
    await assert.rejects(() => safeFetch("http://metadata.google.internal/"), /SSRF blocked/);
    assert.equal(seen.length, 0);
  });

  it("honours noProxy and url:false", async () => {
    configureProxy({ url: proxyUrl, noProxy: "bypass.test.example" });
    assert.equal(resolveProxy(new URL("https://bypass.test.example/")), null);
    assert.ok(resolveProxy(new URL("https://other.test.example/")));
    configureProxy({ url: false });
    assert.equal(resolveProxy(new URL("https://other.test.example/")), null);
  });

  it("EnhancedSearch({ proxy }) configures the shared HTTP layer", () => {
    new EnhancedSearch({ proxy: proxyUrl, noProxy: [] });
    assert.equal(resolveProxy(new URL("https://x.test.example/"))?.url.port, String(proxy.address().port));
    new EnhancedSearch({ proxy: false });
    assert.equal(resolveProxy(new URL("https://x.test.example/")), null);
  });

  it("rejects unsupported proxy schemes", () => {
    assert.throws(() => configureProxy({ url: "socks5://127.0.0.1:1080" }), /only http:\/\/ and https:\/\//);
  });
});
