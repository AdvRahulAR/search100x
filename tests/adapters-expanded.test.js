import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HackerNewsEngine,
  GitHubEngine,
  ArXivEngine,
  toPromptContext,
  EnhancedSearch,
  DOMAIN_PRESETS,
} from "../dist/index.js";

describe("Expanded Adapters & Prompt Context Synthesizer", () => {
  test("HackerNewsEngine returns structured discussion results", async () => {
    const hn = new HackerNewsEngine();
    const results = await hn.search("rust web framework", 6000);
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      const first = results[0];
      assert.ok(first.title.length > 0);
      assert.ok(first.url.startsWith("http"));
      assert.ok(typeof first.snippet === "string");
    }
  });

  test("GitHubEngine returns repositories with star counts", async () => {
    const gh = new GitHubEngine();
    const results = await gh.search("fastapi", 6000);
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      const first = results[0];
      assert.ok(first.title.length > 0);
      assert.ok(first.url.includes("github.com"));
      assert.ok(first.snippet.includes("★"));
    }
  });

  test("ArXivEngine parses XML preprints into academic results", async () => {
    const arxiv = new ArXivEngine();
    const results = await arxiv.search("attention is all you need", 8000);
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      const first = results[0];
      assert.ok(first.title.length > 0);
      assert.ok(first.url.includes("arxiv.org"));
      assert.ok(first.snippet.length > 0);
    }
  });

  test("toPromptContext formats numeric citations with token budget enforcement", () => {
    const mockResults = [
      {
        title: "Quantum Computing in 2026",
        url: "https://example.com/quantum",
        snippet: "A comprehensive review of superconducting qubits and fault-tolerant architectures.",
        score: 0.95,
        sources: ["wikipedia", "bing"],
      },
      {
        title: "Photonic Quantum Processors",
        url: "https://example.com/photonic",
        snippet: "Photonic chips operating at room temperature achieve major milestones.",
        score: 0.88,
        sources: ["arxiv"],
      },
      {
        title: "Low scoring result",
        url: "https://example.com/low",
        snippet: "Irrelevant content.",
        score: 0.05, // should be filtered out by minScore
        sources: ["mojeek"],
      },
    ];

    const context = toPromptContext(mockResults, { minScore: 0.10, limit: 5 });
    assert.ok(context.includes('[1] "Quantum Computing in 2026"'));
    assert.ok(context.includes("URL: https://example.com/quantum"));
    assert.ok(context.includes("Sources: wikipedia, bing"));
    assert.ok(context.includes('[2] "Photonic Quantum Processors"'));
    assert.ok(!context.includes("Low scoring result"), "Should filter out below minScore");

    // Test tight token budgeting
    const budgeted = toPromptContext(mockResults, { maxChars: 150 });
    assert.ok(budgeted.length <= 160);
  });

  test("DOMAIN_PRESETS includes tech preset", () => {
    assert.ok(DOMAIN_PRESETS["tech"]);
    assert.ok(DOMAIN_PRESETS["tech"].includes("github.com"));
    assert.ok(DOMAIN_PRESETS["tech"].includes("news.ycombinator.com"));
  });

  test("EnhancedSearch supports tech preset queries", async () => {
    const search = new EnhancedSearch({ timeoutMs: 7000 });
    const res = await search.search("sqlite vector search", {
      preset: "tech",
      limit: 3,
    });
    assert.equal(res.query, "sqlite vector search");
    assert.ok(typeof res.count === "number");
    assert.ok(Array.isArray(res.results));
  });
});
