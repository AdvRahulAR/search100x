/**
 * Per-source test: node tests/sources.test.js
 * Tests each engine adapter in isolation.
 */
import { DuckDuckGoEngine } from "../dist/adapters/duckduckgo.js";
import { BingEngine }       from "../dist/adapters/bing.js";
import { MojeekEngine }     from "../dist/adapters/mojeek.js";
import { GoogleNewsEngine } from "../dist/adapters/googlenews.js";
import { BingNewsEngine }   from "../dist/adapters/bingnews.js";
import { WikipediaEngine }  from "../dist/adapters/wikipedia.js";

const QUERY   = "SC AI Regulations 2026";
const TIMEOUT = 9000;

async function test(name, fn) {
  process.stdout.write(`[${name.padEnd(20)}] `);
  const t0 = Date.now();
  try {
    const res = await fn();
    const ms  = Date.now() - t0;
    if (!res.length) { console.log(`⚠️  0 results (${ms}ms)`); return; }
    console.log(`✅ ${String(res.length).padStart(3)} results  ${ms}ms`);
    console.log(`   title:   ${res[0].title.slice(0, 72)}`);
    console.log(`   url:     ${res[0].url.slice(0, 72)}`);
    console.log(`   snippet: ${res[0].snippet.slice(0, 80)}`);
  } catch (e) {
    console.log(`❌ ${Date.now()-t0}ms  ${e.message}`);
  }
  console.log();
}

console.log(`\nQuery: "${QUERY}"\n${"─".repeat(74)}\n`);

await test("DuckDuckGo",   () => new DuckDuckGoEngine().search(QUERY, TIMEOUT));
await test("Bing Web",     () => new BingEngine().search(QUERY, TIMEOUT));
await test("Mojeek",       () => new MojeekEngine().search(QUERY, TIMEOUT));
await test("Google News",  () => new GoogleNewsEngine("IN").search(QUERY, TIMEOUT));
await test("Bing News",    () => new BingNewsEngine().search(QUERY, TIMEOUT));
await test("Wikipedia",    () => new WikipediaEngine().search(QUERY, TIMEOUT));

console.log("─".repeat(74));
