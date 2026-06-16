import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EnhancedSearch, rrfScore, normalizeUrl } from "../dist/index.js";

// ─── Unit tests: math layer ───────────────────────────────────────────────────

describe("RRF scorer", () => {
  it("single engine rank-1 gives correct score", () => {
    const score = rrfScore([{ engine: "brave", weight: 0.9, rank: 1 }]);
    assert.ok(Math.abs(score - 0.9 / 11) < 1e-10, `Expected ${0.9/11}, got ${score}`);
  });

  it("cross-engine agreement accumulates score", () => {
    const single = rrfScore([{ engine: "bing", weight: 0.75, rank: 1 }]);
    const dual   = rrfScore([
      { engine: "bing",  weight: 0.75, rank: 1 },
      { engine: "brave", weight: 0.90, rank: 1 },
    ]);
    assert.ok(dual > single, "Two engines at rank-1 should score higher than one");
  });

  it("lower rank gives lower contribution", () => {
    const rank1  = rrfScore([{ engine: "ddg", weight: 0.8, rank: 1  }]);
    const rank10 = rrfScore([{ engine: "ddg", weight: 0.8, rank: 10 }]);
    assert.ok(rank1 > rank10, "Rank 1 should score higher than rank 10");
  });

  it("k=10 makes rank-1 contribution 1/11 × weight", () => {
    const got      = rrfScore([{ engine: "x", weight: 1.0, rank: 1 }]);
    const expected = 1.0 / (10 + 1);
    assert.ok(Math.abs(got - expected) < 1e-12);
  });
});

describe("URL normalizer", () => {
  it("strips www, forces https, removes trailing slash", () => {
    const a = normalizeUrl("http://www.example.com/path/");
    const b = normalizeUrl("https://example.com/path");
    assert.equal(a, b);
  });

  it("removes tracking params but keeps content params", () => {
    const a = normalizeUrl("https://example.com?q=test&utm_source=google");
    const b = normalizeUrl("https://example.com?q=test");
    assert.equal(a, b);
  });

  it("strips fragment", () => {
    const a = normalizeUrl("https://example.com/page#section");
    const b = normalizeUrl("https://example.com/page");
    assert.equal(a, b);
  });
});

// ─── Integration tests: live search ──────────────────────────────────────────

describe("EnhancedSearch (live)", () => {
  it("returns results with required fields", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("DPDP Act India compliance");
    assert.ok(res.count > 0, "Should return at least one result");
    assert.ok(res.durationMs > 0);
    const r = res.results[0];
    assert.ok(r.title.length > 0);
    assert.ok(r.url.startsWith("http"));
    assert.ok(r.snippet.length > 0);
    assert.ok(r.score >= 0 && r.score <= 1, `Score out of [0,1]: ${r.score}`);
  });

  it("deduplicates — all URLs are unique", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("Supreme Court India AI 2026");
    const urls = res.results.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length, "Duplicate URLs found");
  });

  it("respects limit", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("Indian contract act", { limit: 5 });
    assert.ok(res.results.length <= 5);
  });

  it("results are sorted by score descending", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("GST act India 2026");
    for (let i = 1; i < res.results.length; i++) {
      assert.ok(
        res.results[i].score <= res.results[i - 1].score + 1e-9,
        `Out of order at [${i}]: ${res.results[i-1].score} → ${res.results[i].score}`
      );
    }
  });

  it("cross-engine consensus lifts average score", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("SC AI draft regulations India", { limit: 15 });
    const multi  = res.results.filter((r) => r.sources.length > 1);
    const single = res.results.filter((r) => r.sources.length === 1);
    if (!multi.length || !single.length) {
      console.warn("  [skip] need both multi and single-source results to compare");
      return;
    }
    // Average score of multi-engine results should exceed average of single-engine.
    // Individual exceptions are valid: a rank-1 single-engine result can outscore
    // a rank-10 two-engine result — that is correct behaviour at k=10.
    const avg = (arr) => arr.reduce((s, r) => s + r.score, 0) / arr.length;
    assert.ok(
      avg(multi) >= avg(single),
      `Avg multi-engine score (${avg(multi).toFixed(3)}) should ≥ avg single (${avg(single).toFixed(3)})`
    );
  });

  it("snippet length ≤ 210 chars", async () => {
    const s   = new EnhancedSearch();
    const res = await s.search("Indian penal code section 420");
    for (const r of res.results) {
      assert.ok(r.snippet.length <= 210, `Snippet too long (${r.snippet.length}): "${r.snippet.slice(0,40)}…"`);
    }
  });

  it("free-only mode uses no premium sources", async () => {
    const s   = new EnhancedSearch(); // no API keys
    const res = await s.search("DPDP Act India");
    const premiumSources = new Set(["brave", "tavily", "google"]);
    for (const r of res.results) {
      const hasPremium = r.sources.some((src) => premiumSources.has(src));
      assert.ok(!hasPremium, `Result from premium source without key: ${r.sources}`);
    }
  });
});
