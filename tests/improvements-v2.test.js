import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarginaliaEngine } from "../dist/adapters/marginalia.js";
import { YepEngine } from "../dist/adapters/yep.js";
import { domainReputation, spamSignalScore } from "../dist/core/reputation.js";
import { clusterResults } from "../dist/core/cluster.js";
import { reformulateQuery } from "../dist/core/reformulator.js";
import { http } from "../dist/core/http.js";

describe("Marginalia Adapter", () => {
  it("queries Marginalia API and returns RawResult[]", async () => {
    const originalGet = http.get;
    http.get = async () => ({
      data: {
        results: [
          { title: "Indie Web", url: "https://indie.web", description: "Indie description" }
        ]
      }
    });

    try {
      const engine = new MarginaliaEngine();
      const results = await engine.search("indie web", 3000);
      assert.equal(results.length, 1);
      assert.equal(results[0].title, "Indie Web");
      assert.equal(results[0].url, "https://indie.web");
    } finally {
      http.get = originalGet;
    }
  });
});

describe("Yep Adapter", () => {
  it("queries Yep API and returns RawResult[]", async () => {
    const originalGet = http.get;
    http.get = async () => ({
      data: {
        organic: [
          { title: "Yep Search", url: "https://yep.com", snippet: "Yep snippet" }
        ]
      }
    });

    try {
      const engine = new YepEngine();
      const results = await engine.search("yep search", 3000);
      assert.equal(results.length, 1);
      assert.equal(results[0].title, "Yep Search");
      assert.equal(results[0].url, "https://yep.com");
    } finally {
      http.get = originalGet;
    }
  });
});

describe("Domain Reputation & Quality Filter", () => {
  it("boosts known authoritative domains above default", () => {
    const githubRep = domainReputation("https://github.com/some/repo");
    const spamRep = domainReputation("https://buy-cheap-vpn.net");
    assert.ok(githubRep > spamRep, `Expected githubRep (${githubRep}) > spamRep (${spamRep})`);
    assert.ok(githubRep > 1.0, `Expected github boost > 1.0, got ${githubRep}`);
    assert.strictEqual(spamRep, 1.0, "Unknown domain should return neutral multiplier 1.0");
  });

  it("penalizes spammy titles/snippets with graded penalty", () => {
    // Single spam pattern: 1.0 - 0.20 = 0.80
    const singleHit = spamSignalScore("Top 10 Best VPNs", "");
    assert.ok(singleHit < 1.0, `Single spam signal should reduce score, got ${singleHit}`);
    assert.ok(singleHit >= 0.40, `Score should not drop below floor 0.40, got ${singleHit}`);
    // Multiple spam patterns hit the floor at 0.40
    const multiHit = spamSignalScore("Top 10 Best VPNs Click Here", "Get cheap discount!");
    assert.ok(multiHit <= singleHit, `More spam patterns should score lower: ${multiHit} <= ${singleHit}`);
    assert.ok(multiHit >= 0.40, `Score floor is 0.40, got ${multiHit}`);
    // Clean title: no penalty
    const clean = spamSignalScore("GDPR compliance requirements 2024", "The regulation requires...");
    assert.strictEqual(clean, 1.0, `Clean title should score 1.0, got ${clean}`);
  });
});

describe("Result Clustering", () => {
  it("deduplicates results and groups them into clusters", () => {
    const results = [
      { title: "GDPR Compliance Rules", url: "https://a.com", snippet: "desc 1", score: 0.9, sources: ["google"] },
      { title: "GDPR Compliance Guidelines", url: "https://b.com", snippet: "desc 2", score: 0.8, sources: ["google"] },
      { title: "Different Topic Entirely", url: "https://c.com", snippet: "desc 3", score: 0.7, sources: ["google"] }
    ];
    const clustered = clusterResults(results, 5, 0.35);
    assert.equal(clustered.length, 3);
    assert.equal(clustered[0].title, "GDPR Compliance Rules");
    assert.equal(clustered[1].title, "Different Topic Entirely");
    assert.equal(clustered[2].title, "GDPR Compliance Guidelines");
  });
});

describe("Query Reformulator", () => {
  it("strips question words to keyword form", () => {
    const reformulations = reformulateQuery("What are GDPR requirements?");
    assert.ok(reformulations.includes("GDPR requirements"));
  });

  it("adds question prefix to declarative query", () => {
    const reformulations = reformulateQuery("GDPR obligations");
    assert.ok(reformulations.includes("What are GDPR obligations?"));
  });
});
