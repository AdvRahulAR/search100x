import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simhash, hammingDistance, queryFingerprint } from "../dist/core/cache.js";
import { classifyQuery } from "../dist/core/classifier.js";
import { expandQuery } from "../dist/core/transformer.js";
import { normaliseScores } from "../dist/core/scorer.js";

describe("SimHash semantic cache", () => {
  it("computes identical hashes for canonical query forms", () => {
    const a = simhash("GDPR compliance requirements");
    const b = simhash("requirements compliance GDPR");
    assert.equal(a, b);
  });

  it("small changes fall within distance <= 3", () => {
    const a = simhash("GDPR compliance requirements");
    const b = simhash("GDPR requirements");
    const dist = hammingDistance(a, b);
    assert.ok(dist <= 3, `Expected distance <= 3, got ${dist}`);
  });

  it("temporal year changes trigger high distance > 3", () => {
    const a = simhash("AI regulation 2024");
    const b = simhash("AI regulation 2025");
    const dist = hammingDistance(a, b);
    assert.ok(dist > 3, `Expected temporal change distance > 3, got ${dist}`);
  });
});

describe("Query auto-classifier", () => {
  it("classifies legal query correctly", () => {
    const res = classifyQuery("GDPR right to erasure compliance");
    assert.equal(res.category, "legal");
    assert.ok(res.confidence > 0.6);
  });

  it("classifies news query correctly", () => {
    const res = classifyQuery("Breaking: Fed raises rates today");
    assert.equal(res.category, "news");
    assert.ok(res.confidence > 0.6);
  });

  it("classifies academic query correctly", () => {
    const res = classifyQuery("attention mechanism arxiv paper");
    assert.equal(res.category, "academic");
    assert.ok(res.confidence > 0.6);
  });

  it("falls back to general for generic queries", () => {
    const res = classifyQuery("best hotels in Kochi");
    assert.equal(res.category, "general");
  });
});

describe("Query expansion", () => {
  it("expands query with synonyms", () => {
    const orig = "GDPR right to erasure";
    const expanded = expandQuery(orig);
    assert.ok(expanded.includes("GDPR") && expanded.includes("deletion"));
  });

  it("does not expand generic query", () => {
    const orig = "best hotels in Kochi";
    const expanded = expandQuery(orig);
    assert.equal(expanded, orig);
  });
});

describe("Sigmoid normalization", () => {
  it("normalizes RRF scores using shifted sigmoid", () => {
    const scores = [0.05, 0.12, 0.20];
    const normalized = normaliseScores(scores, 3);
    assert.equal(normalized.length, 3);
    for (const score of normalized) {
      assert.ok(score >= 0 && score <= 1);
    }
    // High score (0.20) should have high normalized score
    assert.ok(normalized[2] > 0.8);
    // Low score (0.05) should have low normalized score
    assert.ok(normalized[0] < 0.2);
  });
});
