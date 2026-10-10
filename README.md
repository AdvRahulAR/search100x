# search100x

**Multi-source web search for LLM grounding — works with any model provider.**

Aggregates results from DuckDuckGo, Bing, Mojeek, Google News, Bing News, Wikipedia, Brave, Tavily, Google Search, Marginalia, Yep, HackerNews, GitHub, ArXiv, IndianKanoon, IndiaCode, SEBI, and SearXNG into a single ranked list using RRF + BM25 scoring. Extracts relevant page passages and formats them for any LLM's context window.

[![npm version](https://img.shields.io/npm/v/search100x)](https://www.npmjs.com/package/search100x)
[![license](https://img.shields.io/npm/l/search100x)](./LICENSE)
[![install size](https://img.shields.io/bundlephobia/min/search100x)](https://bundlephobia.com/package/search100x)

![](docs/tagline.png)

![](docs/scoring-algorithm.png)

---

## How it compares

![](docs/cost-comparison.png)

![](docs/capability-comparison.png)

![](docs/leads-trails.png)

---

## Features

- **15+ search engines in parallel** — 100% zero-API-key free engines (DuckDuckGo, Bing, HackerNews, GitHub, ArXiv, Wikipedia, Mojeek, etc.) + optional premium APIs
- **Ultra-Lightweight Micro-Server (<25MB RAM)** — native `node:http` standalone server with drop-in SearXNG API compatibility (`format=json`), embedded dark-mode Web UI, SSE streaming, and `/read` content extractor
- **MCP Server Protocol (Model Context Protocol)** — built-in stdio MCP server (`search100x --mcp`) for Claude Desktop, Cursor, Cline, and AI agents
- **Zero-Filesystem Sandbox Mode** — isomorphic in-memory runtime (`search100x/sandbox`) for browser workers, Cloudflare Workers, and Deno
- **RAG Prompt Context Synthesizer** — `toPromptContext()` generates clean, token-budgeted markdown with numbered citations `[1]`, `[2]` for instant LLM prompt injection
- **SearXNG integration (opt-in)** — set `searxng.baseUrl` or `SEARXNG_URL` to add your own instance's ~70 sub-engines. No queries are sent to any SearXNG instance unless you configure one
- **Silent Browser Automation (Zero-Bloat CDP)** — 0MB Chromium download; uses native WebSocket over Chrome DevTools Protocol to bypass Cloudflare/WAF, 403 Forbidden blocks, and JS-heavy pages with explicit user permission
- **4-factor cascade scoring** — RRF × authority × BM25 × recency, with presets for `tech`, `news`, `legal`, and `academic`
- **Cross-engine + sub-engine consensus** — results confirmed by multiple engines are boosted logarithmically
- **Content extraction & Stealth** — fetches actual page text with automated browser profile rotation and token-bucket rate limiting
- **Cross-encoder re-ranking** — optional `rerank: true` uses ONNX semantic reranking
- **Domain presets** — `tech`, `india-legal`, `us-legal`, `uk-legal`, `eu-legal`, `academic`, and more
- **Streaming** — `searchStream()` async generator yields results as each engine completes
- **Plugin API** — register custom engines, disable built-ins, inspect circuit breaker state
- **Tiny install** — one runtime dependency (`node-html-parser`); `unpdf` and `onnxruntime-node` are optional peers you install only if you need PDFs or reranking
- **SSRF-hardened fetching** — page fetches validate the resolved IP on every connection and redirect hop, and cap response size

---

## Install

```bash
npm install search100x
```

No API keys required for basic usage. Brave and Tavily keys unlock premium results.

Requires Node.js 18+. The package is **ESM-only** — use `import`, or `await import("search100x")` from CommonJS.

> **How results are obtained:** the free engines are queried by fetching their public HTML/RSS pages with browser-like request headers. This can break when a site changes its markup, may be rate-limited or blocked, and may conflict with a site's terms of service. For production use, prefer the official APIs (Brave, Tavily, Google CSE) or your own SearXNG instance.

---

## Quick start

```typescript
import { EnhancedSearch } from "search100x";

const s = new EnhancedSearch();
const res = await s.search("SC AI Committee Draft Regulations 2026");

console.log(res.results);
// [{ title, url, snippet, score, sources }, ...]
```

---

## Usage with LLM providers

### Anthropic Claude — with Citations API

The `toDocuments()` helper formats results into Claude's native document format.
Claude's citations reference documents by `document_index`; `citationSources()` maps each index back to its URL.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { EnhancedSearch, buildCitedQuery, citationSources, DOMAIN_PRESETS } from "search100x";

const s = new EnhancedSearch();
const res = await s.search("Online Safety Act obligations for platforms", {
  scopedDomains: DOMAIN_PRESETS["uk-legal"],
  enrichContent: 5,   // fetch full relevant passages from top 5 pages
  limit: 10,
});

const anthropic = new Anthropic();
const msg = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  ...buildCitedQuery(res.results, "What are the key obligations for platforms under the Online Safety Act?"),
});

// Map citations back to URLs — same filters/order as buildCitedQuery's documents
const sources = citationSources(res.results);
for (const block of msg.content) {
  if (block.type !== "text") continue;
  for (const c of block.citations ?? []) {
    if ("document_index" in c) console.log(c.cited_text, "→", sources[c.document_index].url);
  }
}
```

---

### OpenAI — GPT-4o / o1

Inject search results as grounding context in the system prompt.

```typescript
import OpenAI from "openai";
import { EnhancedSearch } from "search100x";

const s      = new EnhancedSearch();
const client = new OpenAI();

const query = "EU AI Act prohibited practices";
const res   = await s.search(query, { enrichContent: 5, limit: 8 });

// Format results as grounding context
const context = res.results
  .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content ?? r.snippet}`)
  .join("\n\n---\n\n");

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [
    {
      role: "system",
      content: `You are a helpful assistant. Answer using only the search results below.\n\n${context}`,
    },
    { role: "user", content: query },
  ],
});

console.log(completion.choices[0].message.content);
```

---

### Google Gemini

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import { EnhancedSearch } from "search100x";

const s      = new EnhancedSearch();
const genAI  = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const model  = genAI.getGenerativeModel({ model: "gemini-3.1-pro" });

const query = "DPDP Act India compliance requirements";
const res   = await s.search(query, { enrichContent: 5, limit: 8 });

const context = res.results
  .map((r) => `Title: ${r.title}\nSource: ${r.url}\n${r.content ?? r.snippet}`)
  .join("\n\n---\n\n");

const result = await model.generateContent(
  `Using the following search results:\n\n${context}\n\nAnswer: ${query}`
);

console.log(result.response.text());
```

---

### Sarvam AI

[Sarvam AI](https://www.sarvam.ai/) is India's foundational AI model with strong support for Indian languages — Hindi, Tamil, Telugu, Kannada, Bengali, and more. Use `search100x` to ground Sarvam with live legal and news results from authoritative Indian sources.

```typescript
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";

const SARVAM_API_KEY = process.env.SARVAM_API_KEY!;
const s = new EnhancedSearch();

const res = await s.search("SC AI Committee Draft Regulations 2026", {
  scopedDomains: DOMAIN_PRESETS["india-legal"],
  enrichContent: 5,
  limit: 10,
});

const context = res.results
  .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.url}\n${r.content ?? r.snippet}`)
  .join("\n\n---\n\n");

const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "api-subscription-key": SARVAM_API_KEY,
  },
  body: JSON.stringify({
    model: "sarvam-m",
    messages: [
      {
        role: "system",
        content: `You are a helpful legal assistant for Indian law. Use the search results below to answer.\n\n${context}`,
      },
      {
        role: "user",
        content: "What does the SC AI Committee Draft Regulations 2026 say about prohibited AI uses in courts?",
      },
    ],
  }),
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

**Multilingual tip:** Sarvam handles Indian language queries natively. Pass a Hindi or Tamil query directly to `s.search()` — the engines will return relevant results and Sarvam will interpret them in the user's language.

```typescript
// Query in Hindi
const res = await s.search("न्यायालयों में एआई के उपयोग पर नियम 2026", {
  scopedDomains: DOMAIN_PRESETS["india-legal"],
  enrichContent: 3,
});
```

---

### OpenClaw

[OpenClaw](https://openclaw.in/) is an AI-powered legal research platform for Indian law. Use `search100x` to augment OpenClaw workflows with live web search results from authoritative Indian legal sources — Supreme Court judgments, ministry circulars, SEBI/RBI notices, and more.

```typescript
import { EnhancedSearch, DOMAIN_PRESETS, toDocuments } from "search100x";

const s = new EnhancedSearch();

// Search across Indian legal domains + case law repositories
const res = await s.search("Section 43A IT Act data protection liability", {
  scopedDomains: [
    ...DOMAIN_PRESETS["india-legal"],
    "indiankanoon.org",
    "main.sci.gov.in",
    "districts.ecourts.gov.in",
  ],
  enrichContent: 5,
  limit: 10,
});

// Format for LLM-backed legal analysis with citations
const docs = toDocuments(res.results);

// Each doc.context = source URL (use citationSources() to map Claude's document_index → URL)
// Each doc.source.data = extracted relevant passage
// Pass to any LLM for legal reasoning with cited sources
console.log(`Found ${docs.length} cited sources for legal analysis`);

docs.forEach((d, i) => {
  console.log(`\n[${i + 1}] ${d.title}`);
  console.log(`    Source: ${d.context}`);
  console.log(`    Preview: ${d.source.data.slice(0, 150)}...`);
});

// Use with Claude for a cited legal answer
import Anthropic from "@anthropic-ai/sdk";
import { buildCitedQuery } from "search100x";

const anthropic = new Anthropic();
const msg = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  ...buildCitedQuery(
    res.results,
    "What is the liability of a body corporate under Section 43A for data protection failures?"
  ),
});
console.log(msg.content);
```

**Built-in `india-legal` preset (25 domains) includes:**

| Domain | Authority |
|---|---|
| `indiacode.nic.in` | Ministry of Law & Justice — full statute text |
| `supremecourt.gov.in`, `main.sci.gov.in`, `sci.gov.in` | Supreme Court of India |
| `legislative.gov.in`, `egazette.gov.in`, `doj.gov.in` | Bills, Acts, Gazette notifications |
| `sebi.gov.in`, `rbi.org.in`, `irdai.gov.in`, `trai.gov.in`, `ibbi.gov.in` | Regulators |
| `mca.gov.in`, `meity.gov.in`, `gst.gov.in`, `india.gov.in`, `ncbc.gov.in` | Ministries, commissions & portals |
| `nclt.gov.in`, `nclat.nic.in`, `tdsat.gov.in` | Tribunals |
| `indiankanoon.org`, `livelaw.in`, `barandbench.com`, `scconline.com`, `scobserver.in` | Case law & legal news |

Run `DOMAIN_PRESETS["india-legal"]` (or `GET /presets`) for the authoritative list. With `scopedDomains`, **only** results from these domains are returned (see `scopeMode`).

---

### Hermes Agent (NousResearch)

[Hermes](https://huggingface.co/NousResearch) models (Hermes-3-Llama, Hermes-2-Pro) excel at agentic tool use and structured function calling. Use `search100x` as a tool in a Hermes agentic loop via Ollama, llama.cpp, or any OpenAI-compatible endpoint.

```typescript
import OpenAI from "openai"; // Hermes exposes an OpenAI-compatible API
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";

// Point to your local Hermes endpoint
const client = new OpenAI({
  baseURL: process.env.HERMES_BASE_URL ?? "http://localhost:11434/v1",
  apiKey:  "ollama",
});

const s = new EnhancedSearch();

// Define search100x as a callable tool for Hermes
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for up-to-date information. Returns ranked results with source URLs and extracted content.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          preset: {
            type: "string",
            enum: ["india-legal", "us-legal", "uk-legal", "eu-legal", "au-legal", "sg-legal", "academic"],
            description: "Optional domain preset to restrict search to authoritative sources",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10)",
          },
        },
        required: ["query"],
      },
    },
  },
];

// Agentic loop — Hermes decides when to call search and when to answer
const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  {
    role: "system",
    content: "You are a legal research assistant. Use the web_search tool to find current information before answering.",
  },
  {
    role: "user",
    content: "What are the key rules in the SC AI Committee Draft Regulations 2026 for Indian courts?",
  },
];

while (true) {
  const resp = await client.chat.completions.create({
    model:       "hermes3",
    messages,
    tools,
    tool_choice: "auto",
  });

  const choice = resp.choices[0];
  messages.push(choice.message);

  if (choice.finish_reason !== "tool_calls") {
    console.log("\nFinal answer:\n", choice.message.content);
    break;
  }

  // Execute each tool call
  for (const call of choice.message.tool_calls ?? []) {
    const args = JSON.parse(call.function.arguments) as {
      query: string;
      preset?: string;
      limit?: number;
    };

    const res = await s.search(args.query, {
      scopedDomains: args.preset ? DOMAIN_PRESETS[args.preset as keyof typeof DOMAIN_PRESETS] : undefined,
      limit:         args.limit ?? 10,
      enrichContent: 5,
    });

    const toolResult = res.results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content ?? r.snippet}`)
      .join("\n\n---\n\n");

    messages.push({
      role:         "tool",
      tool_call_id: call.id,
      content:      toolResult,
    });

    console.log(`[tool] Searched: "${args.query}" → ${res.count} results in ${res.durationMs}ms`);
  }
}
```

**Running Hermes locally with Ollama:**

```bash
# Install Ollama — https://ollama.com
ollama pull nous-hermes2        # 7B, fast
ollama pull hermes3             # Llama 3.1 based, best tool use
ollama serve

# Run your agent
HERMES_BASE_URL=http://localhost:11434/v1 node agent.js
```

**Running on Together AI / Fireworks (hosted Hermes):**

```typescript
const client = new OpenAI({
  baseURL: "https://api.together.xyz/v1",
  apiKey:  process.env.TOGETHER_API_KEY!,
});
// model: "NousResearch/Hermes-3-Llama-3.1-70B"
```

---

### LangChain

Use `search100x` as a LangChain `Tool` inside any chain or ReAct agent.

```typescript
import { ChatOpenAI }    from "@langchain/openai";
import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
import { DynamicTool }   from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";

const s = new EnhancedSearch();

const searchTool = new DynamicTool({
  name: "web_search",
  description: "Search the web for current information. Input is a search query string.",
  func: async (query: string) => {
    const res = await s.search(query, { enrichContent: 3, limit: 8 });
    return res.results
      .map((r) => `${r.title}\n${r.url}\n${r.content ?? r.snippet}`)
      .join("\n\n---\n\n");
  },
});

const llm    = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful research assistant with access to web search."],
  ["placeholder", "{chat_history}"],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent    = await createOpenAIFunctionsAgent({ llm, tools: [searchTool], prompt });
const executor = new AgentExecutor({ agent, tools: [searchTool], verbose: true });

const result = await executor.invoke({
  input: "What are the prohibited AI uses in Indian courts under the 2026 draft regulations?",
});
console.log(result.output);
```

---

### Vercel AI SDK

Use `search100x` as a `tool()` inside a streaming AI response.

```typescript
import { openai }                from "@ai-sdk/openai";
import { streamText, tool }      from "ai";
import { z }                     from "zod";
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";

const s = new EnhancedSearch();

const result = streamText({
  model: openai("gpt-4o"),
  tools: {
    webSearch: tool({
      description: "Search the web for current information",
      parameters: z.object({
        query:  z.string().describe("Search query"),
        preset: z.enum(["india-legal", "us-legal", "uk-legal", "eu-legal", "academic"])
                 .optional()
                 .describe("Domain preset for authoritative sources"),
      }),
      execute: async ({ query, preset }) => {
        const res = await s.search(query, {
          scopedDomains: preset ? DOMAIN_PRESETS[preset] : undefined,
          enrichContent: 3,
          limit: 8,
        });
        return res.results.map((r) => ({
          title:   r.title,
          url:     r.url,
          content: r.content ?? r.snippet,
          score:   r.score,
        }));
      },
    }),
  },
  prompt: "What are the SC AI Committee Draft Regulations 2026?",
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

---

## Corporate proxies

All outbound requests (engines, page fetches, SearXNG) honour the standard proxy environment variables. Nothing extra to install:

```bash
export HTTPS_PROXY=http://user:pass@proxy.corp:8080   # https targets (CONNECT tunnel, TLS end-to-end)
export HTTP_PROXY=http://proxy.corp:8080              # http targets
export NO_PROXY=localhost,127.0.0.1,.internal.corp,10.0.0.0/8
npx search100x "DPDP rules 2025"
```

Or configure it in code or on the CLI:

```typescript
const s = new EnhancedSearch({ proxy: "http://proxy.corp:8080", noProxy: ["searxng.internal.corp"] });
// proxy: false → ignore the environment and connect directly
```

```bash
npx search100x "query" --proxy http://proxy.corp:8080
npx search100x serve --no-proxy
```

- `NO_PROXY` supports `*`, `example.com` (plus subdomains), `.example.com`, `*.example.com`, `host:port`, IP literals and CIDR ranges.
- Both `http://` and `https://` proxies are supported. Proxy credentials go in the URL and are sent as `Proxy-Authorization: Basic`. SOCKS proxies are not supported.
- Proxy settings are process-wide.
- If the proxy refuses a host, `res.engines[name].error` says so, e.g. `Proxy CONNECT to html.duckduckgo.com:443 failed: HTTP/1.1 403 Forbidden`.
- SSRF protection still applies. Private IP literals and internal hostnames are rejected before anything reaches the proxy, and names that resolve locally to private addresses are blocked too. If the target can't be resolved locally (only the proxy has DNS), the proxy's own egress rules decide.
- The headless-browser fallback is launched with `--proxy-server`. Chrome can't take credentials from the URL, so an authenticating proxy may reject the browser.

## SearXNG integration

SearXNG is **opt-in**: it is enabled only when you pass `searxng.baseUrl` or set `SEARXNG_URL` (with optional `SEARXNG_TOKEN`). Connect your own SearXNG instance to route queries through ~70 additional sub-engines (Google, Bing, Brave, DuckDuckGo, Startpage, Qwant, Yahoo, and more) in a single parallel call. Results from SearXNG are merged with native engines using the same RRF + cascade scoring — sub-engines that agree on a result amplify its consensus bonus.

```typescript
import { EnhancedSearch } from "search100x";

const s = new EnhancedSearch({
  searxng: {
    baseUrl: "https://searxng.example.com",   // your instance (localhost is allowed here)
    token:   process.env.SEARXNG_TOKEN,      // if your instance requires auth
    engines: "google,bing,brave,ddg",         // optional: restrict sub-engines
  },
});

const res = await s.search("DPDP Act India 2025", {
  scoringPreset: "legal",
  limit: 10,
});
```

**Self-hosting on Fly.io (free tier):**
```bash
fly launch --image searxng/searxng --name my-searxng
fly secrets set SEARXNG_SECRET_KEY=$(openssl rand -hex 32)
fly deploy
# Your endpoint: https://my-searxng.fly.dev
```

**Scoring presets** — tune the 4-factor cascade for your query type:

| Preset | rrf | bm25 | authority | recency | Best for |
|--------|-----|------|-----------|---------|----------|
| `default` | 0.45 | 0.30 | 0.15 | 0.10 | General web |
| `news` | 0.40 | 0.25 | 0.10 | 0.25 | Breaking news, current events |
| `legal` | 0.45 | 0.35 | 0.18 | 0.02 | Laws, regulations, court orders |
| `academic` | 0.42 | 0.33 | 0.22 | 0.03 | Research papers, journals |

**Cross-encoder re-ranking** (optional — requires `onnxruntime-node`):
```bash
npm install onnxruntime-node
node scripts/download-reranker.mjs   # downloads ~23MB ONNX model once
```
```typescript
const res = await s.search("query", { rerank: true, rerankCandidates: 20 });
```

---

## Domain Categories & Presets

`search100x` packages curated, authoritative domain directories structured into 5 core industry categories: **Legal**, **Tech**, **Business**, **Academic**, and **Medical**.

### 1. Categories & Presets Catalog

| Category | Presets Included | Focus Domains |
|---|---|---|
| **Legal** | `legal`, `india-legal`, `us-legal`, `uk-legal`, `eu-legal`, `au-legal`, `sg-legal` | `law.cornell.edu`, `indiacode.nic.in`, `eur-lex.europa.eu`, `legislation.gov.uk`, `courtlistener.com`, `supremecourt.gov` |
| **Tech** | `tech`, `tech-ai`, `tech-dev`, `tech-security`, `tech-cloud` | `github.com`, `huggingface.co`, `news.ycombinator.com`, `cve.mitre.org`, `nvd.nist.gov`, `kubernetes.io`, `aws.amazon.com` |
| **Business** | `business`, `business-india`, `finance`, `crypto`, `startups` | `bloomberg.com`, `reuters.com`, `wsj.com`, `ft.com`, `techcrunch.com`, `coindesk.com`, `livemint.com`, `economictimes.indiatimes.com` |
| **Academic** | `academic` | `arxiv.org`, `pubmed.ncbi.nlm.nih.gov`, `ssrn.com`, `jstor.org`, `nature.com`, `science.org` |
| **Medical** | `medical` | `ncbi.nlm.nih.gov`, `who.int`, `cdc.gov`, `thelancet.com`, `nejm.org`, `fda.gov`, `mayoclinic.org` |

### 2. Programmatic Usage

```typescript
import { 
  DOMAIN_PRESETS, 
  DOMAIN_CATEGORIES, 
  getCategoryDomains, 
  resolvePresetDomains 
} from "search100x";

// 1. Resolve an entire category (e.g. all curated tech domains)
const techDomains = getCategoryDomains("tech");

// 2. Resolve a specific preset or category name dynamically
const startupDomains = resolvePresetDomains("startups");
const legalDomains   = resolvePresetDomains("legal");

// 3. Pass directly to search with optimized scoring preset
const s = new EnhancedSearch();
const res = await s.search("series A valuations AI startups", {
  scopedDomains: resolvePresetDomains("startups"),
  scoringPreset: "business",
  limit: 5,
});
```

### 3. CLI Usage with Categories & Presets

```bash
# Scope by high-level category
npx search100x "interest rate inflation" --preset business
npx search100x "data privacy obligations" --preset legal
npx search100x "kubernetes privilege escalation" --preset tech

# Scope by specialized sub-preset
npx search100x "seed stage term sheet" --preset startups
npx search100x "solana dex liquidity" --preset crypto
npx search100x "rbi draft directions fintech" --preset business-india
```

---

## Streaming search

Results arrive as each engine completes — faster time-to-first-result.

```typescript
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";

const s = new EnhancedSearch();

for await (const batch of s.searchStream("SEC enforcement actions 2024", {
  scopedDomains: DOMAIN_PRESETS["us-legal"],
})) {
  console.log(`Batch: ${batch.length} results`);
  console.log(batch[0].title);
}
```

---

## Self-Hosted Micro-Server (<25MB RAM) & SearXNG Drop-in

`search100x` ships with a zero-dependency, ultra-lightweight HTTP server built on Node's native `node:http`. It runs on **~8.5MB heap (<25MB RAM)** and serves as a 100% free, self-hosted alternative to heavy SearXNG instances (which need Python, Redis, and ~300MB RAM).

```bash
# Start micro-server (zero extra dependencies required) — listens on 127.0.0.1 by default
npx search100x serve --port 3000

# Expose on the network: always set an API key
SEARCH100X_API_KEY=change-me npx search100x serve --host 0.0.0.0
curl -H "Authorization: Bearer change-me" "http://server:3000/search?q=test"
```

| Setting | Env var | Default |
|---|---|---|
| Bind address | `HOST` / `--host` | `127.0.0.1` |
| API key (Bearer or `X-API-Key`; `/health` exempt) | `SEARCH100X_API_KEY` | none |
| Rate limit per client IP | `SEARCH100X_RATE_LIMIT` | 60 req/min (`0` disables) |
| Allow `browser=true` requests | `SEARCH100X_ALLOW_BROWSER=1` | off |

Request parameters are clamped: `limit` 1–50, `enrich` 0–5, `/read` `maxChars` 100–20000 and `timeoutMs` 1000–15000.

### Endpoints & Integrations:

| Endpoint | Description |
|---|---|
| `GET /` | Embedded dark-mode Web UI (<5KB HTML, zero external assets) for browsers |
| `GET /search?q=...` | Standard search100x JSON multi-source consensus search |
| `GET /search?q=...&format=json` | **SearXNG drop-in API**: exact SearXNG JSON schema (works with LangChain, Dify, Open WebUI, AutoGPT) |
| `GET /search?q=...&stream=true` | Server-Sent Events (SSE) streaming search |
| `GET /read?url=...&q=...` | Grounded page reader: fetches URL and extracts top BM25 passages |
| `GET /presets` | Lists domain presets (`india-legal`, `us-legal`, `uk-legal`, `academic`, etc.) |
| `GET /health` | Health status and live memory usage stats |
| `GET /metrics` | Circuit breaker status per search engine |

### In-Browser & Sandbox Runtime (`search100x/sandbox`)

For serverless environments, Cloudflare Workers, Deno, Web Workers, or browser extensions:

```typescript
import { createSandboxSearch, isomorphicSearch, isomorphicRead } from "search100x/sandbox";

// Zero-filesystem, purely in-memory execution
const results = await isomorphicSearch("EU AI Act obligations", { limit: 5 });
const passage = await isomorphicRead("https://eur-lex.europa.eu/...", "fines");
```

---

## Silent Browser Automation via Chrome DevTools Protocol (CDP)

`search100x` includes a zero-dependency, zero-download silent browser automation engine. Instead of bundling a 300MB Chromium download like Puppeteer or Playwright, `search100x` directly communicates with your system's existing Google Chrome, Chromium, or Microsoft Edge browser over standard Chrome DevTools Protocol (CDP) using Node's native global `WebSocket` and `node:http`.

### Key Benefits
- **JavaScript-Heavy SPAs**: Extracts rendered content from client-rendered React, Vue, Angular, and Next.js sites that return empty shells to standard `fetch`.
- **WAF & Cloudflare Challenges**: Seamlessly bypasses Turnstile, bot challenges, and HTTP 403 Forbidden blocks.
- **Adaptive 2-Tier Fallback**: Always uses ultrafast `fetch` first, automatically cascading to silent headless browser automation only when challenged.
- **Bot Evasion**: Strips `navigator.webdriver` via `--disable-blink-features=AutomationControlled` and Page script evaluation.

### Strict User Permission Model
Browser automation **never** runs without explicit user authorization:
- In Node/TS code: require `browser: { enabled: true }`
- In CLI: pass the `--browser` flag
- In Micro-Server: pass `?browser=true`
- In MCP Server: pass `"browser": true`

### Programmatic Usage

```typescript
import { fetchWithBrowser, EnhancedSearch } from "search100x";

// 1. Direct headless page extraction
const page = await fetchWithBrowser("https://example.com", {
  enabled: true,           // Explicit consent required
  headless: true,          // Runs invisibly in background
  timeoutMs: 15000,
  waitForNetworkIdle: true,
});
console.log(page.title, page.text);

// 2. Multi-engine search with silent browser enrichment fallback
const s = new EnhancedSearch({
  browser: { enabled: true },
});

const res = await s.search("Next.js App Router client actions", {
  enrichContent: 3,        // Headless browser fallback if HTTP 403 occurs
});
```

---

## CLI & Server Commands

```bash
# Standard search with domain presets or specific sources
npx search100x "transformer attention" --sources hackernews,arxiv,github --limit 5
npx search100x "sqlite vector" --preset tech --limit 5
npx search100x "Online Safety Act 2023" --preset uk-legal --limit 8
npx search100x "EU AI Act" --scope eur-lex.europa.eu,ec.europa.eu --enrich 3
npx search100x "SEC rule 10b-5" --preset us-legal --json

# Search with silent browser automation fallback for protected pages
npx search100x "Cloudflare protected report" --enrich 3 --browser

# Connect to existing Chrome instance running with remote debugging
# (chrome.exe --remote-debugging-port=9222)
npx search100x "Protected document" --enrich 1 --cdp http://127.0.0.1:9222

# Start the <25MB RAM standalone micro-server (SearXNG drop-in + Web UI)
npx search100x serve --port 3000

# Launch stdio MCP server for Claude Desktop / Cursor / AI IDEs
npx search100x --mcp
```

---

## API reference

### `new EnhancedSearch(config?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `braveApiKey` | `string` | — | Brave Search API key |
| `tavilyApiKey` | `string` | — | Tavily API key |
| `googleApiKey` | `string` | — | Google Custom Search key |
| `googleCx` | `string` | — | Google Custom Search engine ID |
| `timeoutMs` | `number` | `7000` | Total search timeout |
| `newsRegion` | `string` | `"US"` | ISO 3166-1 alpha-2 country code |
| `cache` | `IResultCache` | in-memory | Custom cache backend |
| `searxng` | `SearXNGConfig` | — | SearXNG instance — adds ~70 sub-engines |
| `proxy` | `string \| false` | env | HTTP(S) proxy, e.g. `http://user:pass@proxy.corp:8080`. Default: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`. `false` disables (env ignored) |
| `noProxy` | `string \| string[]` | `NO_PROXY` env | Hosts that bypass the proxy |

**`SearXNGConfig`**

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | **Required.** Your SearXNG instance URL. Without it (and without `SEARXNG_URL`), SearXNG is disabled |
| `token` | `string` | Bearer token if your instance requires auth — sent only to `baseUrl` |
| `fallbackUrls` | `string[]` | Extra instances tried if `baseUrl` fails (no token is sent to these) |
| `engines` | `string` | Comma-separated sub-engines, e.g. `"google,bing,brave,ddg"` — blank = all |
| `language` | `string` | BCP-47 language code, default `"en"` |
| `timeRange` | `string` | `"day"` \| `"week"` \| `"month"` \| `"year"` |

### `search(query, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `15` | Max results (integer 1–100) |
| `scopedDomains` | `string[]` | — | Domains (and subdomains) to search. All domains are queried via `site:` clauses in chunks of 6 (up to 30 domains) |
| `scopeMode` | `"strict"\|"boost"` | `"strict"` | `strict`: return only results on `scopedDomains`. `boost`: also keep unscoped results |
| `enrichTopN` | `number` | `0` | Replace snippet with best passage from top-N pages |
| `enrichContent` | `number` | `0` | Populate `result.content` with all relevant passages |
| `noCache` | `boolean` | `false` | Skip result cache |
| `timeRange` | `"day"\|"week"\|"month"\|"year"` | — | Freshness filter |
| `page` | `number` | `1` | Result page |

Every response includes `engines` — a per-engine status map (`{ ok, ms, count, error?, skipped? }`) so you can see why a search came back empty — and `cached: true` when served from cache. The cache key covers the query and every option that changes the output.

### `toDocuments(results, options?)`

Formats `SearchResult[]` into the Anthropic Citations API document shape.
Falls back to `result.snippet` when `result.content` is not populated.

### `toPromptContext(results, options?)`

Synthesizes search results into a clean, numbered markdown context block ready for instant injection into any LLM prompt (OpenAI, Gemini, Ollama, Anthropic, Sarvam, etc.).

```typescript
import { EnhancedSearch, toPromptContext } from "search100x";

const s = new EnhancedSearch();
const res = await s.search("sqlite vector search", { preset: "tech", limit: 5 });

const promptContext = toPromptContext(res.results, {
  maxTokens: 1500,     // strict token budget
  includeSources: true,
});

const prompt = `Use the verified search results below to answer the user query:

${promptContext}

User Query: How do I run vector search in SQLite?`;
```

Produces structured citations:
```markdown
[1] "Show HN: SQLite-vector – Vector search extension for SQLite (no index, 30MB RAM)"
URL: https://github.com/sqliteai/sqlite-vector
Sources: hackernews
Discussion on Hacker News: Show HN: SQLite-vector – Vector search extension for SQLite (no index, 30MB RAM)

[2] "sqlite-vss: A SQLite extension for vector search"
URL: https://github.com/asg017/sqlite-vss
Sources: github
[2.8k ★] A SQLite extension for efficient vector search based on Faiss
```

### `buildCitedQuery(results, question, options?)`

Returns a complete `messages.create()` payload for Anthropic — pass it with spread:

```typescript
await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  ...buildCitedQuery(results, question, { maxTokens: 2048 }),
});
```

Includes a `system` prompt telling the model that documents are untrusted web content (override with `system`, or `""` to omit). Document text is passed through unmodified so cited text stays clean.

### `citationSources(results, options?)`

Returns `{ documentIndex, title, url, resultIndex }[]` in the same order as `toDocuments()` (same options ⇒ same filtering). Use `sources[citation.document_index].url` to link each citation.

### `FileResultCache`

Persist search results across process restarts:

```typescript
import { EnhancedSearch, FileResultCache } from "search100x";

const s = new EnhancedSearch({
  cache: new FileResultCache("./cache/search.json", 60 * 60 * 1000), // 1-hour TTL
});
```

---

## Plugin API

```typescript
// Register a custom engine
s.use(myEngine);

// Disable a built-in engine
s.remove("mojeek");

// Inspect circuit breaker state per engine
console.log(s.metrics());
// { duckduckgo: { state: "CLOSED", failures: 0 }, bing: { state: "CLOSED", failures: 0 }, ... }
```

---

## How scoring works

1. **Weighted RRF with adaptive k** — `score = Σ_engine weight / (k + rank)`, where `k = clamp(⌊0.29 × N⌋, 10, 150)` and N is the number of merged results.
2. **Consensus bonus** — `× (1 + 0.15 × ln(distinct engines))`; SearXNG results get a further `× (1 + 0.12 × ln(sub-engines))` when several sub-engines agree.
3. **Sigmoid normalisation** — RRF scores are mapped to `(0, 1)` with a sigmoid whose midpoint scales with the number of engines queried.
4. **Cascade** — normalised RRF is blended with title/snippet BM25, domain authority and recency using the preset weights (table above). Legal/authority boosts can push a final score slightly above 1.
5. **Passage BM25** — when `enrichContent > 0`, fetched page text is split into overlapping 200-word windows (500 in legal mode). Windows above a BM25 threshold are selected using non-maximum suppression and joined in document order.

Engine weights reflect index quality (unknown/plugin engines default to 0.60):

```
searxng         = 1.30   indiankanoon = 1.20   indiacode / sebi = 1.10
tavily / google = 1.00   brave        = 0.90   arxiv            = 0.90
googlenews      = 0.85   startpage    = 0.85   duckduckgo       = 0.80
wikipedia       = 0.80   hackernews   = 0.80   bing / bingnews  = 0.75
github          = 0.75   yep          = 0.70   openalex         = 0.70
mojeek          = 0.65   marginalia   = 0.62
```

6. **Clustering & Reputation Filter**:
   - **Domain Reputation Filter**: Matches domains against boost lists (authoritative sources) and checks titles and snippets for low-quality/spam regex patterns (deals, affiliate links, clickbait) to scale the authority score component.
   - **Result Clustering**: Groups results into subtopic clusters based on title Jaccard token similarity and selects the highest-scoring representative from each cluster first to ensure query coverage and diversity.

---

## Contributing

Pull requests welcome. To add a new search engine:

1. Create `src/adapters/<name>.ts` implementing `Engine`
2. Add the name to `SourceName` in `src/core/types.ts`
3. Add a weight in `ENGINE_WEIGHTS` in `src/core/scorer.ts`
4. Add one line in `src/search.ts → initEngines()`

```bash
npm run build   # compile
npm test        # build + run all tests (hits live network)
```

---

## License

MIT © 2026 [Rahul - Dharmabot AI](https://dharmabot.ai)
