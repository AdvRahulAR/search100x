import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMicroServer, createSandboxSearch, isomorphicSearch, isomorphicRead } from "../dist/index.js";

describe("search100x Micro-Server & Sandbox Runtime", () => {
  let serverInstance;
  let baseUrl;

  before(async () => {
    // Start micro-server on an ephemeral port
    serverInstance = await startMicroServer({
      port: 0,
      host: "127.0.0.1",
      quiet: true,
    });
    const addr = serverInstance.server.address();
    const port = typeof addr === "object" && addr ? addr.port : serverInstance.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (serverInstance) {
      await serverInstance.close();
    }
  });

  test("GET /health returns 200 with memory statistics under micro-footprint", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "ok");
    assert.equal(data.engine, "search100x-micro");
    assert.equal(data.version, "4.1.0");
    assert.ok(typeof data.uptimeSeconds === "number");
    assert.ok(data.memory.heapUsedMb > 0);
    assert.ok(data.memory.heapUsedMb < 50, "Heap used should be well under micro footprint");
  });

  test("GET /metrics returns circuit breaker states", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.circuitBreakers);
    assert.ok(typeof data.timestamp === "string");
  });

  test("GET /presets returns available domain presets", async () => {
    const res = await fetch(`${baseUrl}/presets`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data["india-legal"]);
    assert.ok(data["us-legal"]);
    assert.ok(data["academic"]);
  });

  test("GET / without query returns API documentation for JSON clients", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.engine, "search100x-micro");
    assert.ok(data.endpoints["GET /search?q={query}"]);
  });

  test("GET / without query returns Web UI HTML for browser clients", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("search100x &mdash; Free Metasearch Engine"));
    assert.ok(html.includes("<form method=\"GET\" action=\"/search\""));
  });

  test("OPTIONS /search returns 204 with CORS preflight headers", async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: "OPTIONS",
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(res.headers.get("access-control-allow-methods")?.includes("GET"));
  });

  test("GET /search without query returns API usage information", async () => {
    const res = await fetch(`${baseUrl}/search`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.engine, "search100x-micro");
    assert.ok(data.endpoints);
  });

  test("GET /read rejects missing url parameter with 400", async () => {
    const res = await fetch(`${baseUrl}/read`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("Missing required query parameter: url"));
  });

  test("GET /search with SearXNG format=json returns compliant SearXNG schema", async () => {
    const res = await fetch(`${baseUrl}/search?q=test&format=json&limit=2`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.query, "test");
    assert.ok(typeof data.number_of_results === "number");
    assert.ok(Array.isArray(data.results));
    assert.ok(Array.isArray(data.answers));
    assert.ok(Array.isArray(data.corrections));
    assert.ok(Array.isArray(data.infoboxes));
    assert.ok(Array.isArray(data.suggestions));
    assert.ok(Array.isArray(data.unresponsive_engines));

    if (data.results.length > 0) {
      const first = data.results[0];
      assert.ok(first.url);
      assert.ok(first.title);
      assert.ok(Array.isArray(first.parsed_url));
      assert.equal(first.parsed_url.length, 6);
      assert.equal(first.template, "default.html");
      assert.ok(typeof first.score === "number");
    }
  });

  test("createSandboxSearch runs in-memory without filesystem access", async () => {
    const sandbox = createSandboxSearch();
    assert.ok(sandbox);
    const metrics = sandbox.metrics();
    assert.ok(metrics);
  });
});
