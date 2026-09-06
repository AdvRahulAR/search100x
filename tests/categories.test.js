import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_CATEGORIES,
  DOMAIN_PRESETS,
  getCategoryDomains,
  listDomainCategories,
  listDomainPresets,
  resolvePresetDomains,
  SCORING_PRESETS,
  TECH_WEIGHTS,
  BUSINESS_WEIGHTS,
  EnhancedSearch,
} from "../dist/index.js";

test("Domain Categories -- Registry and Resolution", async (t) => {
  await t.test("exports all required core categories", () => {
    const cats = listDomainCategories();
    assert.ok(cats.includes("legal"), "should include legal");
    assert.ok(cats.includes("tech"), "should include tech");
    assert.ok(cats.includes("business"), "should include business");
    assert.ok(cats.includes("academic"), "should include academic");
    assert.ok(cats.includes("medical"), "should include medical");
  });

  await t.test("legal category contains jurisdictional presets and domains", () => {
    const legal = DOMAIN_CATEGORIES.legal;
    assert.equal(legal.name, "Legal");
    assert.ok(legal.presets["india-legal"]);
    assert.ok(legal.presets["us-legal"]);
    assert.ok(legal.presets["uk-legal"]);
    assert.ok(legal.presets["eu-legal"]);
    assert.ok(legal.allDomains.includes("indiacode.nic.in"));
    assert.ok(legal.allDomains.includes("law.cornell.edu"));
    assert.ok(legal.allDomains.includes("legislation.gov.uk"));
    assert.ok(legal.allDomains.includes("eur-lex.europa.eu"));
  });

  await t.test("tech category contains specialized sub-presets", () => {
    const tech = DOMAIN_CATEGORIES.tech;
    assert.equal(tech.name, "Tech");
    assert.ok(tech.presets["tech"]);
    assert.ok(tech.presets["tech-ai"]);
    assert.ok(tech.presets["tech-dev"]);
    assert.ok(tech.presets["tech-security"]);
    assert.ok(tech.presets["tech-cloud"]);
    assert.ok(tech.allDomains.includes("github.com"));
    assert.ok(tech.allDomains.includes("huggingface.co"));
    assert.ok(tech.allDomains.includes("stackoverflow.com"));
    assert.ok(tech.allDomains.includes("cve.mitre.org"));
    assert.ok(tech.allDomains.includes("kubernetes.io"));
  });

  await t.test("business category contains financial and startup sub-presets", () => {
    const biz = DOMAIN_CATEGORIES.business;
    assert.equal(biz.name, "Business");
    assert.ok(biz.presets["business"]);
    assert.ok(biz.presets["business-india"]);
    assert.ok(biz.presets["finance"]);
    assert.ok(biz.presets["crypto"]);
    assert.ok(biz.presets["startups"]);
    assert.ok(biz.allDomains.includes("bloomberg.com"));
    assert.ok(biz.allDomains.includes("reuters.com"));
    assert.ok(biz.allDomains.includes("economictimes.indiatimes.com"));
    assert.ok(biz.allDomains.includes("techcrunch.com"));
    assert.ok(biz.allDomains.includes("coindesk.com"));
  });

  await t.test("getCategoryDomains returns deduplicated domain list", () => {
    const legalDomains = getCategoryDomains("legal");
    assert.ok(Array.isArray(legalDomains));
    assert.ok(legalDomains.length > 20);
    assert.equal(new Set(legalDomains).size, legalDomains.length);

    const techDomains = getCategoryDomains("tech");
    assert.ok(techDomains.includes("github.com"));
    assert.ok(techDomains.includes("huggingface.co"));

    const bizDomains = getCategoryDomains("business");
    assert.ok(bizDomains.includes("bloomberg.com"));
    assert.ok(bizDomains.includes("wsj.com"));

    assert.deepEqual(getCategoryDomains("BUSINESS"), bizDomains);
  });

  await t.test("resolvePresetDomains resolves both category and preset names", () => {
    const indiaLegal = resolvePresetDomains("india-legal");
    assert.ok(indiaLegal?.includes("indiacode.nic.in"));

    const crypto = resolvePresetDomains("crypto");
    assert.ok(crypto?.includes("coindesk.com"));

    const techAi = resolvePresetDomains("tech-ai");
    assert.ok(techAi?.includes("huggingface.co"));

    const techCat = resolvePresetDomains("tech");
    assert.ok(techCat?.includes("github.com"));

    const bizCat = resolvePresetDomains("business");
    assert.ok(bizCat?.includes("bloomberg.com"));

    assert.equal(resolvePresetDomains("non-existent-preset-123"), undefined);
  });

  await t.test("SCORING_PRESETS includes tech and business weights", () => {
    assert.deepEqual(SCORING_PRESETS.tech, TECH_WEIGHTS);
    assert.deepEqual(SCORING_PRESETS.business, BUSINESS_WEIGHTS);
    assert.equal(Math.round((TECH_WEIGHTS.rrf + TECH_WEIGHTS.bm25 + TECH_WEIGHTS.authority + TECH_WEIGHTS.recency) * 100) / 100, 1.0);
    assert.equal(Math.round((BUSINESS_WEIGHTS.rrf + BUSINESS_WEIGHTS.bm25 + BUSINESS_WEIGHTS.authority + BUSINESS_WEIGHTS.recency) * 100) / 100, 1.0);
  });

  await t.test("EnhancedSearch supports tech and business presets", async () => {
    const search = new EnhancedSearch({ timeoutMs: 4000 });
    const res = await search.search("sqlite vector search", {
      scoringPreset: "tech",
      limit: 2,
    });
    assert.ok(res);
    assert.ok(res.results.length <= 2);
  });
});
