/**
 * search100x Micro-Server — ultra-lightweight, zero-dependency HTTP server
 *
 * Runs under <25MB RAM using native `node:http`.
 * Acts as a 100% free, self-hosted, keyless alternative to heavy SearXNG instances.
 *
 * Features:
 * - Drop-in SearXNG API compatibility (`/search?q=...&format=json`)
 * - Native search100x JSON API (`/search?q=...`)
 * - Embedded dark-mode responsive Web UI (<5KB, zero external assets)
 * - Server-Sent Events (SSE) streaming (`/search?q=...&stream=true`)
 * - One-shot BM25 passage extraction endpoint (`/read?url=...&q=...`)
 * - Health check with live memory statistics (`/health`)
 * - Circuit breaker observability (`/metrics`)
 * - Domain presets directory (`/presets`)
 */

import http, { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { EnhancedSearch, DOMAIN_PRESETS } from "./search.js";
import { fetchRelevantContent, fetchPageContent } from "./core/fetcher.js";
import { SourceName, SearchOptions, SearchResult, SearchConfig } from "./core/types.js";

export interface MicroServerOptions {
  port?: number;
  host?: string;
  searchConfig?: SearchConfig;
  quiet?: boolean;
}

export interface MicroServerInstance {
  server: http.Server;
  port: number;
  host: string;
  close: () => Promise<void>;
  search: EnhancedSearch;
}

/** Parses URL components into SearXNG-style parsed_url tuple: [scheme, netloc, path, params, query, fragment] */
function parseUrlToSearxngTuple(urlString: string): [string, string, string, string, string, string] {
  try {
    const u = new URL(urlString);
    return [
      u.protocol.replace(":", ""),
      u.host,
      u.pathname,
      "",
      u.search.replace(/^\?/, ""),
      u.hash.replace(/^#/, ""),
    ];
  } catch {
    return ["http", "", "", "", "", ""];
  }
}

/** Converts search100x results into SearXNG-compatible JSON response */
function toSearxngFormat(query: string, results: SearchResult[], unresponsiveEngines: string[] = []): Record<string, unknown> {
  return {
    query,
    number_of_results: results.length,
    results: results.map((r, index) => ({
      url: r.url,
      title: r.title,
      content: r.snippet || "",
      engine: r.sources[0] ?? "search100x",
      parsed_url: parseUrlToSearxngTuple(r.url),
      template: "default.html",
      engines: r.sources,
      positions: [index + 1],
      score: r.score,
      category: r.type ?? "general",
      pretty_url: r.url,
      publishedDate: r.publishedAt ? r.publishedAt.toISOString() : undefined,
    })),
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: unresponsiveEngines,
  };
}

/** Embedded minimal Web UI (<5KB HTML/CSS) */
function renderWebUi(query = "", preset = "", resultsJson = ""): string {
  const presetOptions = Object.keys(DOMAIN_PRESETS)
    .map((p) => `<option value="${p}" ${p === preset ? "selected" : ""}>${p}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>search100x &mdash; Free Metasearch Engine</title>
  <style>
    :root { --bg: #0f1117; --card: #181b24; --border: #2b3040; --text: #e2e8f0; --dim: #94a3b8; --accent: #38bdf8; --badge: #1e293b; --accent-hover: #0284c7; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; padding: 2rem 1rem; }
    .container { max-width: 820px; margin: 0 auto; }
    header { margin-bottom: 2rem; display: flex; align-items: baseline; justify-content: space-between; }
    h1 { font-size: 1.8rem; font-weight: 700; color: #fff; letter-spacing: -0.03em; }
    h1 span { color: var(--accent); }
    .tagline { font-size: 0.85rem; color: var(--dim); }
    .search-box { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    input[type="text"] { flex: 1; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: #fff; font-size: 1rem; outline: none; }
    input[type="text"]:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2); }
    select { padding: 0.75rem; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: #fff; font-size: 0.9rem; outline: none; }
    button { padding: 0.75rem 1.5rem; border-radius: 8px; border: none; background: var(--accent); color: #0f1117; font-weight: 600; cursor: pointer; font-size: 1rem; transition: background 0.15s; }
    button:hover { background: var(--accent-hover); }
    .meta { font-size: 0.85rem; color: var(--dim); margin-bottom: 1.25rem; }
    .results { display: flex; flex-direction: column; gap: 1rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.1rem; }
    .card-title { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.3rem; }
    .card-title a { color: var(--accent); text-decoration: none; }
    .card-title a:hover { text-decoration: underline; }
    .card-url { font-size: 0.78rem; color: #10b981; margin-bottom: 0.5rem; word-break: break-all; }
    .card-snip { font-size: 0.92rem; color: var(--text); margin-bottom: 0.6rem; }
    .badges { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
    .badge { font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px; background: var(--badge); border: 1px solid var(--border); color: var(--dim); }
    .badge-score { color: var(--accent); font-weight: 600; }
    .read-btn { font-size: 0.72rem; margin-left: auto; color: var(--accent); text-decoration: none; border: 1px solid var(--border); padding: 0.15rem 0.5rem; border-radius: 4px; }
    .read-btn:hover { background: rgba(56, 189, 248, 0.1); }
    footer { margin-top: 3rem; text-align: center; font-size: 0.8rem; color: var(--dim); border-top: 1px solid var(--border); padding-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>search<span>100x</span></h1>
      <div class="tagline">100% Free &bull; Zero-Key &bull; Micro Metasearch (&lt;25MB RAM)</div>
    </header>

    <form method="GET" action="/search" class="search-box">
      <input type="text" name="q" value="${escapeHtml(query)}" placeholder="Search the web with multi-source consensus..." autofocus required>
      <select name="preset">
        <option value="">No Preset</option>
        ${presetOptions}
      </select>
      <input type="hidden" name="format" value="html">
      <button type="submit">Search</button>
    </form>

    <div id="results-container"></div>
  </div>

  <script>
    const resultsData = ${resultsJson || "null"};
    if (resultsData && resultsData.results) {
      const container = document.getElementById("results-container");
      let html = '<div class="meta">Found ' + resultsData.results.length + ' results in ' + (resultsData.durationMs || 0) + 'ms &bull; Engines: ' + (resultsData.sources || []).join(", ") + '</div><div class="results">';
      resultsData.results.forEach((r, idx) => {
        const pct = Math.round(r.score * 100);
        html += '<div class="card">' +
          '<div class="card-title"><a href="' + r.url + '" target="_blank" rel="noopener">' + escapeHtml(r.title) + '</a></div>' +
          '<div class="card-url">' + escapeHtml(r.url) + '</div>' +
          '<div class="card-snip">' + escapeHtml(r.snippet || "") + '</div>' +
          '<div class="badges">' +
            '<span class="badge badge-score">' + pct + '% match</span>' +
            '<span class="badge">' + (r.sources || []).join(", ") + '</span>' +
            '<a class="read-btn" href="/read?url=' + encodeURIComponent(r.url) + '&q=' + encodeURIComponent("${escapeHtml(query)}") + '" target="_blank">📖 Read Content</a>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
      container.innerHTML = html;
    }
    function escapeHtml(str) {
      if (!str) return "";
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Sends JSON response with CORS headers */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Cache-Control": "no-cache",
  });
  res.end(payload);
}

/** Sends HTML response */
function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(html);
}

/** Handles CORS preflight OPTIONS request */
function handleCorsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

/** Creates the micro-server HTTP request listener */
export function createMicroServer(options: MicroServerOptions = {}): {
  server: http.Server;
  search: EnhancedSearch;
} {
  const search = new EnhancedSearch(
    options.searchConfig ?? {
      timeoutMs: 7000,
      newsRegion: process.env.NEWS_REGION ?? "US",
    }
  );

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      handleCorsPreflight(res);
      return;
    }

    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { error: `Method ${req.method} not allowed` });
      return;
    }

    const reqUrl = req.url ?? "/";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(reqUrl, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJson(res, 400, { error: "Invalid URL" });
      return;
    }

    const pathname = parsedUrl.pathname;
    const qParams = parsedUrl.searchParams;

    // ── Route: /health ────────────────────────────────────────────────────────
    if (pathname === "/health") {
      const mem = process.memoryUsage();
      sendJson(res, 200, {
        status: "ok",
        engine: "search100x-micro",
        version: "4.1.0",
        uptimeSeconds: Math.round(process.uptime()),
        memory: {
          rssMb: +(mem.rss / (1024 * 1024)).toFixed(2),
          heapUsedMb: +(mem.heapUsed / (1024 * 1024)).toFixed(2),
          heapTotalMb: +(mem.heapTotal / (1024 * 1024)).toFixed(2),
        },
      });
      return;
    }

    // ── Route: /metrics ───────────────────────────────────────────────────────
    if (pathname === "/metrics") {
      sendJson(res, 200, {
        circuitBreakers: search.metrics(),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ── Route: /presets ───────────────────────────────────────────────────────
    if (pathname === "/presets") {
      sendJson(res, 200, DOMAIN_PRESETS);
      return;
    }

    // ── Route: /read ──────────────────────────────────────────────────────────
    if (pathname === "/read") {
      const targetUrl = qParams.get("url");
      const focusQuery = qParams.get("q") ?? qParams.get("query") ?? "";
      const maxChars = Number(qParams.get("maxChars") ?? 3000);
      const timeoutMs = Number(qParams.get("timeoutMs") ?? 6000);

      if (!targetUrl) {
        sendJson(res, 400, { error: "Missing required query parameter: url" });
        return;
      }

      try {
        let content: string | undefined;
        if (focusQuery) {
          content = await fetchRelevantContent(targetUrl, focusQuery, { maxChars, timeoutMs });
        } else {
          content = await fetchPageContent(targetUrl, timeoutMs, maxChars);
        }

        if (!content) {
          sendJson(res, 404, { error: "Could not extract content from the specified URL", url: targetUrl });
          return;
        }

        sendJson(res, 200, {
          url: targetUrl,
          query: focusQuery || undefined,
          chars: content.length,
          content,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Content extraction failed";
        sendJson(res, 500, { error: msg, url: targetUrl });
      }
      return;
    }

    // ── Route: / or /search ───────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/search") {
      const q = qParams.get("q") ?? qParams.get("query");

      // Check if browser is accessing root without query -> serve interactive Web UI
      const acceptHeader = req.headers.accept ?? "";
      const isBrowserRequest = acceptHeader.includes("text/html");
      const requestedFormat = (qParams.get("format") ?? "").toLowerCase();

      if (!q) {
        if (isBrowserRequest && requestedFormat !== "json") {
          sendHtml(res, 200, renderWebUi());
          return;
        }

        // Return API help info
        sendJson(res, 200, {
          engine: "search100x-micro",
          version: "4.1.0",
          endpoints: {
            "GET /search?q={query}": "Search multi-source consensus index",
            "GET /search?q={query}&format=json": "Drop-in SearXNG compatible search response",
            "GET /search?q={query}&stream=true": "Server-Sent Events (SSE) streaming search",
            "GET /read?url={url}&q={query}": "BM25 grounded passage extractor",
            "GET /presets": "List available jurisdiction and domain presets",
            "GET /health": "Server health and memory usage stats",
            "GET /metrics": "Engine circuit breaker metrics",
          },
          memoryUsage: {
            rssMb: +(process.memoryUsage().rss / (1024 * 1024)).toFixed(2),
            heapUsedMb: +(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2),
          },
        });
        return;
      }

      // Parse search options
      const limit = Number(qParams.get("limit") ?? qParams.get("num") ?? 10);
      const enrich = Number(qParams.get("enrich") ?? 0);
      const stream = qParams.get("stream") === "true" || qParams.get("stream") === "1";
      const preset = qParams.get("preset");
      const scope = qParams.get("scope");
      const sourcesParam = qParams.get("sources") ?? qParams.get("engines");
      const isSearxngClient =
        requestedFormat === "json" ||
        qParams.has("categories") ||
        qParams.has("engines") ||
        qParams.has("pageno");

      let scopedDomains: string[] | undefined;
      let scoringPreset: "default" | "news" | "legal" | "academic" | undefined;

      if (preset && DOMAIN_PRESETS[preset]) {
        scopedDomains = DOMAIN_PRESETS[preset];
        scoringPreset = preset.includes("legal") ? "legal" : (preset === "academic" ? "academic" : undefined);
      } else if (scope) {
        scopedDomains = scope.split(",").map((s) => s.trim()).filter(Boolean);
      }

      const sources = sourcesParam ? (sourcesParam.split(",").map((s) => s.trim()) as SourceName[]) : undefined;
      const searchOptions: SearchOptions = {
        limit: Math.min(Math.max(1, limit), 50),
        sources,
        scopedDomains,
        enrichTopN: enrich,
        scoringPreset,
      };

      // ── Handle SSE Streaming Mode ───────────────────────────────────────────
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        let totalYielded = 0;
        try {
          for await (const batch of search.searchStream(q, searchOptions)) {
            const chunk = JSON.stringify({ type: "batch", results: batch, count: batch.length });
            res.write(`data: ${chunk}\n\n`);
            totalYielded = batch.length;
          }
          res.write(`data: ${JSON.stringify({ type: "done", count: totalYielded })}\n\n`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Streaming search error";
          res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
        } finally {
          res.end();
        }
        return;
      }

      // ── Standard Search Mode ────────────────────────────────────────────────
      try {
        const response = await search.search(q, searchOptions);

        // If requested HTML or browser submission
        if (requestedFormat === "html" || (isBrowserRequest && requestedFormat !== "json" && !qParams.get("format"))) {
          sendHtml(res, 200, renderWebUi(q, preset ?? "", JSON.stringify(response)));
          return;
        }

        // SearXNG compatibility mode
        if (isSearxngClient) {
          sendJson(res, 200, toSearxngFormat(q, response.results));
          return;
        }

        // Native search100x format
        sendJson(res, 200, response);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Search failed";
        sendJson(res, 500, { error: msg });
      }
      return;
    }

    // Unknown route
    sendJson(res, 404, { error: `Endpoint ${pathname} not found` });
  });

  return { server, search };
}

/** Starts the micro-server on the configured port/host */
export async function startMicroServer(options: MicroServerOptions = {}): Promise<MicroServerInstance> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const { server, search } = createMicroServer(options);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);

      if (!options.quiet) {
        const mem = process.memoryUsage();
        const rssMb = (mem.rss / (1024 * 1024)).toFixed(1);
        const heapMb = (mem.heapUsed / (1024 * 1024)).toFixed(1);

        console.log(`\n┌─────────────────────────────────────────────────────────────┐`);
        console.log(`│ search100x Micro-Server (v4.1.0)                             │`);
        console.log(`│ Free Metasearch & SearXNG Drop-in Engine                    │`);
        console.log(`├─────────────────────────────────────────────────────────────┤`);
        console.log(`│ Web UI:       http://${host === "0.0.0.0" ? "localhost" : host}:${port}/                     │`);
        console.log(`│ Native API:   http://${host === "0.0.0.0" ? "localhost" : host}:${port}/search?q=...          │`);
        console.log(`│ SearXNG API:  http://${host === "0.0.0.0" ? "localhost" : host}:${port}/search?q=...&format=json│`);
        console.log(`│ Page Ground:  http://${host === "0.0.0.0" ? "localhost" : host}:${port}/read?url=...&q=...    │`);
        console.log(`│ Memory:       ${heapMb}MB heap used (${rssMb}MB RSS)                      │`);
        console.log(`└─────────────────────────────────────────────────────────────┘\n`);
      }

      const instance: MicroServerInstance = {
        server,
        port,
        host,
        search,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      };

      resolve(instance);
    });
  });
}
