#!/usr/bin/env node
/**
 * search100x CLI — multi-source web search for any jurisdiction, any topic
 *
 * Usage:
 *   npx search100x "GDPR article 17 right to erasure"
 *   npx search100x "UK Online Safety Act 2023" --preset uk-legal
 *   npx search100x "SEC enforcement actions 2024" --preset us-legal --limit 10
 *   npx search100x "climate policy EU 2024" --scope eur-lex.europa.eu,ec.europa.eu
 *   npx search100x "DPDP Act India" --preset india-legal --enrich 3
 *   npx search100x "deep learning survey" --preset academic --json
 *
 * Presets: india-legal | us-legal | uk-legal | eu-legal | au-legal | sg-legal | academic
 * Env:     BRAVE_API_KEY, TAVILY_API_KEY, GOOGLE_API_KEY, GOOGLE_CX, NEWS_REGION
 */

import { EnhancedSearch, DOMAIN_PRESETS } from "./search.js";
import { SourceName } from "./core/types.js";
import { startMcpServer } from "./mcp.js";

interface CliArgs {
  query:         string;
  limit:         number;
  sources?:      SourceName[];
  scope?:        string[];
  jsonOutput:    boolean;
  enrichTopN:    number;
  stream:        boolean;
  region:        string;
  minEngines?:   number;
  maxWaitMs?:    number;
  deep?:         boolean;
  noEarlyReturn?: boolean;
  scoringPreset?: "default" | "news" | "legal" | "academic";
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
search100x — multi-source web search for LLM grounding

Usage:
  search100x "<query>" [options]

Options:
  --limit <n>          Max results (default: 10)
  --sources <a,b,...>  Comma-separated engine names
  --preset <name>      Domain preset: india-legal | us-legal | uk-legal |
                       eu-legal | au-legal | sg-legal | academic
  --scope <d1,d2,...>  Custom domain restriction (site: filter), e.g.
                       --scope legislation.gov.uk,ico.org.uk
  --region <CC>        News region ISO 3166-1 code (default: US)
  --enrich <n>         Fetch full page content for top-N results (default: 0)
  --min-engines <n>    Minimum successful engines needed for early-return (default: 3)
  --max-wait <ms>      Maximum wait time in ms before early-return (default: 4000)
  --deep               Deep search mode (queries all engines, waits for thorough results)
  --no-early-return    Disable early-return and wait for all engines
  --stream             Show results as each engine responds
  --json               Output raw JSON (pipe-friendly)
  --mcp                Launch MCP (Model Context Protocol) server over stdio

Engines: duckduckgo, bing, mojeek, googlenews, bingnews, wikipedia,
         searxng, openalex, indiacode, sebi, brave*, tavily*, google*  (* = API key required)

Examples:
  search100x "GDPR right to erasure"
  search100x "Competition Act UK penalties" --preset uk-legal --limit 8
  search100x "SEC rule 10b-5" --preset us-legal --json
  search100x "arbitration clause India" --preset india-legal --enrich 3
  search100x "quantum computing survey" --preset academic --limit 5
  search100x "EU AI Act obligations" --scope eur-lex.europa.eu,ec.europa.eu
    `);
    process.exit(0);
  }

  let query         = "";
  let limit         = 10;
  let sources: SourceName[] | undefined;
  let scope: string[] | undefined;
  let jsonOutput    = false;
  let enrichTopN    = 0;
  let stream        = false;
  let region        = process.env.NEWS_REGION ?? "US";
  let minEngines: number | undefined;
  let maxWaitMs: number | undefined;
  let deep: boolean | undefined;
  let noEarlyReturn: boolean | undefined;
  let presetName: "default" | "news" | "legal" | "academic" | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { query = a; continue; }
    if (a === "--limit")           { limit = Number(args[++i]); continue; }
    if (a === "--sources")         { sources = args[++i].split(",") as SourceName[]; continue; }
    if (a === "--region")          { region = args[++i].toUpperCase(); continue; }
    if (a === "--json")            { jsonOutput = true; continue; }
    if (a === "--enrich")          { enrichTopN = Number(args[++i]); continue; }
    if (a === "--stream")          { stream = true; continue; }
    if (a === "--min-engines")     { minEngines = Number(args[++i]); continue; }
    if (a === "--max-wait")        { maxWaitMs = Number(args[++i]); continue; }
    if (a === "--deep")            { deep = true; continue; }
    if (a === "--no-early-return") { noEarlyReturn = true; continue; }
    if (a === "--preset") {
      const name = args[++i];
      if (!DOMAIN_PRESETS[name]) {
        console.error(`Unknown preset "${name}". Available: ${Object.keys(DOMAIN_PRESETS).join(", ")}`);
        process.exit(1);
      }
      scope = DOMAIN_PRESETS[name];
      presetName = name.includes("legal") ? "legal" : (name === "academic" ? "academic" : undefined);
      continue;
    }
    if (a === "--scope") {
      scope = args[++i].split(",").map((d) => d.trim());
      continue;
    }
  }

  if (!query) {
    console.error("Error: query is required. Run search100x --help for usage.");
    process.exit(1);
  }

  return { query, limit, sources, scope, jsonOutput, enrichTopN, stream, region, minEngines, maxWaitMs, deep, noEarlyReturn, scoringPreset: presetName };
}

function printResult(
  r: { title: string; url: string; snippet: string; score: number; sources: string[] },
  i: number
): void {
  const pct = (r.score * 100).toFixed(0).padStart(3);
  console.log(`\n${String(i + 1).padStart(2)}. [${pct}%] ${r.title}`);
  console.log(`    ${r.url}`);
  if (r.snippet) {
    const snip = r.snippet.length > 140 ? r.snippet.slice(0, 137) + "…" : r.snippet;
    console.log(`    ${snip}`);
  }
  console.log(`    sources: ${r.sources.join(", ")}`);
}

async function main(): Promise<void> {
  const { query, limit, sources, scope, jsonOutput, enrichTopN, stream, region, minEngines, maxWaitMs, deep, noEarlyReturn, scoringPreset } = parseArgs(process.argv);

  const s = new EnhancedSearch({
    braveApiKey:  process.env.BRAVE_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleCx:     process.env.GOOGLE_CX,
    timeoutMs:    10000,
    newsRegion:   region,
    logger:       process.env.DEBUG ? undefined : { warn: () => {}, log: () => {}, debug: () => {} },
  });

  const opts = { limit, sources, scopedDomains: scope, enrichTopN, minEngines, maxWaitMs, deep, noEarlyReturn, scoringPreset };

  if (stream && !jsonOutput) {
    console.log(`\nSearching: "${query}" (streaming)\n${"─".repeat(70)}`);
    let count = 0;
    for await (const batch of s.searchStream(query, opts)) {
      if (batch.length > count) {
        const newOnes = batch.slice(count);
        for (const r of newOnes) printResult(r, count++);
      }
    }
    console.log(`\n${"─".repeat(70)}\n${count} results`);
    return;
  }

  const res = await s.search(query, opts);

  if (jsonOutput) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const activePreset = scope
    ? Object.entries(DOMAIN_PRESETS).find(([, v]) => JSON.stringify(v) === JSON.stringify(scope))?.[0]
    : undefined;
  const scopeLabel = activePreset
    ? ` (preset: ${activePreset})`
    : scope
    ? ` (scope: ${scope.slice(0, 2).join(", ")}${scope.length > 2 ? ` +${scope.length - 2}` : ""})`
    : "";

  console.log(`\nSearch: "${query}"${scopeLabel}`);
  console.log(`Sources: ${res.sources.join(", ")}  |  ${res.count} results  |  ${res.durationMs}ms`);
  console.log("─".repeat(70));
  res.results.forEach((r, i) => printResult(r, i));
  console.log(`\n${"─".repeat(70)}`);
}

if (process.argv.includes("--mcp")) {
  startMcpServer();
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
