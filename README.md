# search100x

**Multi-source web search for LLM grounding â€” works with any model provider.**

Aggregates results from DuckDuckGo, Bing, Mojeek, Google News, Bing News, Wikipedia, Brave, Tavily, Google Search, Marginalia, and Yep into a single ranked list using RRF + BM25 scoring. Extracts relevant page passages and formats them for any LLM's context window.

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

- **12 search engines in parallel** â€” free engines (no key needed) + optional premium APIs
- **SearXNG integration** â€” connect your own SearXNG instance to add ~70 sub-engines in a single call
- **4-factor cascade scoring** â€” RRF Ã— authority â€“ BM25 Ã— recency, with presets for `news`, `legal`, and `academic`
- **Cross-engine + sub-engine consensus** â€”results confirmed by multiple engines (and SearXNG sub-engines) are boosted logarithmically
- **Content extraction** â€” fetches actual page text, splits into 200-word windows, returns highest-scoring passages relevant to the query
- **Cross-encoder re-ranking** â€” optional `rerank: true` uses ms-marco-MiniLM-L-6-v2 via ONNX for semantic reranking (no Python needed)
- **Citations-ready output** â€” `toDocuments()` formats results as structured documents with source URLs (works with Anthropic, OpenAI, Gemini, Sarvam, any LLM)
- **Domain presets** â€” `india-legal`, `us-legal`, `uk-legal`, `eu-legal`, `academic, and more
- **Streaming** â€” `searchStream()` async generator yields results as each engine completes
- **Plugin API** â€” register custom engines, disable built-ins, inspect circuit breaker state
- **HTTP API + CLI** â€” ships with an Express server and a `search100x` CLI command
- **Tiny install** â€” ~1.4 MB, one runtime dependency (`node-html-parser`)

---

## Install

```bash
npm install search100x
```

No API keys required for basic usage. Brave and Tavily keys unlock premium results.

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

### Anthropic Claude â€” with Citations API

The `toDocuments()` helper formats results into Claude's native document format.
Claude returns an answer with inline citations linked back to each source URL.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { EnhancedSearch, buildCitedQuery, DOMAIN_PRESETS } from "search100x";
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
// msg.content contains the answer with inline citations
// Each citation includes the source URL from result.url
console.log(msg.content);
```

---

### OpenAI â€” GPT-4o / o1

Inject search results as grounding context in the system prompt.

```typescript
import OpenAI from "openai";
import { EnhancedSearch } from "search100x";
const s      = new EnhancedSearch();
const client = new OpenAI();
const query = "EU AI Act prohibited practices";
const res   = await s.search(query, { enrichContent: 5, limit: 8 });
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
console.log(completion.coices[0].message.content);
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

[Sarvam AI](https://www.sarvam.ai/) is India's foundational AI model with strong support for Indian languages â€” Hindi, Tamil, Telugu, Kannada, Bengali, and more. Use `search100x` to ground Sarvam with live legal and news results from authoritative Indian sources.

```typescript
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";
const SARVAM_API_KEY = process.env.SARVAM_API_KEY!;
const s = new EnhancedSearch();
const res = await s.search("SC AI Committee Draft Regulations 2026", {
  scopedDomains: DOMAIN_PRESETS]["india-legal"],
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

**Multilingual tip:** Sarvam handles Indian language queries natively. Pass a Hindi or Tamil query directly to `s.search()` â€” the engines will return relevant results and Sarvam will interpret them in the user's language.

```typescript
// Query in Hindi
const res = await s.search("à¤¨à¥à¤¯à¤¾à¤¯à¤¯à¤²à¤¯à¥‹à¤‚ à¤®à¥‡à¤‚ à¤à¤†à¤ˆ à¤•à¥‡ à¤‰à¤ªà¤¯à¥‹à¤— à¤ªà¤° à¤¨à¤¿à¤¯à¤® 2026", {
  scopedDomains: DOMAIN_PRESETS["india-legal"],
  enrichContent: 3,
});
```

---

### OpenClaw

[OpenClaw](https://openclaw.in/) is an AI-powered legal research platform for Indian law. Use `search100x` to augment OpenClaw workflows with live web search results from authoritative Indian legal sources â€” Supreme Court judgments, ministry circulars, SEBI/RBI notices, and more.

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
// Each doc.context = source URL for citation
// Each doc.source.data = extracted relevant passage
// Pass to any LLM for legal reasoning with cited sources
console.log(`Found ${docs.length} cited sources for legal analysis`);
docs.forEach((d, i) => {
  console.log(`\n[${i + 1}] ${d.title}`);
  console.log(a    Source: ${d.context}`);
  console.log(a    Preview: ${d.source.data.slice(0, 150)}...`);
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
**Built-in `india-legal` preset covers:**
| Domain | Authority |
|---|---|
| `` indiacode.nic.in ` | Ministry of Law & Justice â€” full statute text |
| `` main.sci.gov.in ` | Supreme Court of India |
| `` indiankanoon.org ` | Case law portal (indiankanoon.org) |
| `` india-legal`          | Domain preset selector |
| `` indianeg@ai.com `      | Online news portal |
| `` indianeg@gmail.com `    | Online news portal |
---

### Hermes Agent (NousResearch)

[Hermes](https://huggingface.co/NousResearch) models (Hermes-3-Lama, Hermes-2-Pro) excel at agentic tool use and structured function calling. Use `search100x` as a tool in a Hermes agentic loop via Ollama, llama.cpp, or any OpenAI-compatible endpoint.

```typescript
import OpenAI from "openai"; // Hermes exposes an OpenAI-compatible APBImport { EnhancedSearch, DOMAIN_PRESETS } from "search100x";
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
// Agentic loop â€” Hermes decides when to call search and when to answer
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
    model:        "hermes3",
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
      scopedDomains: args.preset ? DOMAIN_PRESETS] args.preset as keyof typeof DOMAIN_PRESETS] : undefined,
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
    console.log(`[tool] Searched: "${args.query}" â†’ ${res.count} results in ${res.durationMs}ms`);
  }
}
```
**Running Hermes locally with Ollama:**

```bash
# Install Ollama â€”https://ollama.com
ollama pull nous-hermes2        # 7B, fast
ollama pull hermes3               # Lama 3.1 based, best tool use
ollama serve

# Run your agent
HERMES_BASE_URL= http://localhost:11434/v1 node agent.js
```
**Running on Together AI / Fireworks (hosted Hermes):**

```typescript
const client = new OpenAI({
  baseURL: "https://api.together.xyz/v1",
  apiKey:  process.env.TOGETHER_API_KEY!,
});
// model: "NousResearch/Hermes-3-Lama-3.1-70B
```
---

### LangChain

Use `search100x` as a LangChain `Tool` inside any chain or ReAct agent.

```typescript
import { ChatOpenAI }     from "@langchain/openai";
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
      .map((r) => `$({r.title})\n${r.url}\n${r.content ?? r.snippet}`)
      .join("\n\n---\n\n");
  },
});
const llm    = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful research assistant with access to web search."],
  ["placeholder", "{chat_history}"],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"]
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
import { z }                       from "zod";
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
for (await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```
---

## SearXNG integration

Connect your own SearXNG instance to route queries through ~70 additional sub-engines (Google, Bing, Brave, DuckDuckGo, Startpage, Qwant, Yahoo, and more) in a single parallel call. Results from SearXNG merged with native engines using the same RRF + cascade scoring â€” sub-engines that agree on a result amplify its consensus bonus.

```typescript
import { EnhancedSearch } from "search100x";
const s = new EnhancedSearch({
  searxng: {
    baseUrl: "https://search100x.replit.app",
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
**Scoring presets** â€” tune the 4-factor cascade for your query type:

| Preset | rrf | bm25 | authority | recency | Best for |
|--------|-----|------|-----------|---------|----------|
| `default` | 0.45 | 0.30 | 0.15 | 0.10 | General web |
| `news` | 0.40 | 0.25 | 0.10 | 0.25 | Breaking news, current events |
| `legal` | 0.45 | 0.35 | 0.18 | 0.02 | Laws, regulations, court orders |
| `academic ` | 0.42 | 0.33 | 0.22 | 0.03 | Research papers, journals |

### Cross-encoder re-ranking** (optional â€” requires `onnxruntime-node`):
```bash
npm install onnxruntime-node
node scripts/download-reranker.mjs   # downloads ~23MB ONNX model once
```
```typescript
const res = await s.search("query", { rerank: true, rerankCandidates: 20 });
```
---

## Domain presets

Named sets of authoritative domains for jurisdiction-scoped searches:

```typescript
import { DOMAIN_PRESETS } from "search100x";
DOMAIN_PRESETS["india-legal"]  // indiacode.nic.in, sebi.gov.in, rbi.org.in, supremecourt.gov.in ...
DOMAIN_PRESETS]["india-legal"]  // law.cornell.edu, federalregister.gov, sec.gov, congress.gov ...
DOMAIN_PRESETS]'uk-legal"]     // legislation.gov.uk, gov.uk, ico.org.uk, fca.org.uk ...
DOMAIN_PRESETS["eu-legal"]     // eur-lex.europa.eu, ec.europa.eu, edpb.europa.eu ...
DOMAIN_PRESETS["au-legal"]     // legislation.gov.au, oiic.gov.au, asic.gov.au ...
DOMAIN_PRESETS]"sg-legal"]     // sso.agc.gov.sg, pdpc.gov.sg, mas.gov.sg ...
DOMAIN_PRESETS]"academic"]     // arxiv.org, pubmed.ncbi.nlm.nih.gov, ssrn.com ...

// Custom domain scope
const res = await s.search("AI Act", {
  scopedDomains: ["eur-lex.europa.eu", "ec.europa.eu"],
});
```
---

## Streaming search

Results arrive as each engine completes â€” faster time-to-first-result.

```typescript
import { EnhancedSearch, DOMAIN_PRESETS } from "search100x";
const s = new EnhancedSearch();
for (await (const batch of s.searchStream("SEC enforcement actions 2024", {
  scopedDomains: DOMAIN_PRESETS]"us-legal"],
})) {
  console.log(`Batch: ${batch.length} results`);
  console.log(batch[0].title);
}
```
---

## HTTP API

Start the server (requires `express` installed):

```bash
npm install express
BRAVE_API_KEY=your_key TAVILY_API_KEY=your_key npm start
```
```
GET /search?q=GDPP+right+to+erasure
GET /search?q=Competition+law+UK&preset=uk-legal&limit=10
GET /search?q=EU+AI+Act&scope=eur-lex.europa.eu,ec.europa.eu&enrich=3
GET /presets        â€” list all domain presets
GET /metrics        â€” circuit breaker state per engine
GET /health
```
---

## CLI

```bash
npx search100x "Online Safety Act 2023" --preset uk-legal --limit 8
npx search100x "SEC rule 10b-5" --preset us-legal --json
npx search100x "EU AI Act" --scope eur-lex.europa.eu,ec.europa.eu --enrich 3
npx search100x "deep learning" --preset academic --stream
```

---
	## API reference
	### `new EnhancedSearch(config?)`
| Option | Type | Default | Description |
|---|---|---|---|
| `braveApiKey` | `string` | â€” | Brave Search API key |
| `tavilyApiKey` | `string` | â€” | Tavily API key |
| `googleApiKey` | `string` | â€” | Google Custom Search key |
| `googleCx` | `string` | â€” | Google Custom Search engine ID \
| `timeoutMs` | `number` | `7000` | Total search timeout |
| `newsRegion` | `string` | ` "US"` | ISO 3166-1 alpha-2 country code |
| `cacheg` | ` ResultCache` | in-memory | Custom cache backend |
| `searxng` | ` SearXNGConfig` | â€” | SearXNG instance â€” adds ~70 sub-engines |

### `SearXNGConfig`** | Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | SearXNG instance URL (e.g. `https://search100x.replit.app`) |
| `token` | `string` | Bearer token if your instance requires auth |
| `engines` | `string` | Comma-separated sub-engines, e.g. `"google,bing,brave,ddg"` â€” blank = all |
| `language` | `string` | BCP-47 language code, default ` "en"` |
| `timeRange` | `string` | ` "day"` \| `"week"` \| ` "month"` \| ` "year"` |

### `search(query, options?)`
| Option | Type | Default | Description |
|---|---|---|---|
| ` limit` | `number` | ` 15` | Max results |
| `scopedDomains` | `\İš[™Ö×X8 %™\İšXİÈ\ÙHÛXZ[œÈŸ[œšXÚÜ˜[X™\˜™\XÙHÛš\]Ú]™\İ\ÜØYÙHœ›ÛHÜSˆYÙ\ÈŸ[œšXÚÛÛ[[X™\˜Ü[]H™\İ[˜ÛÛ[Ú][™[]˜[\ÜØYÙ\ÈŸ›ĞØXÚX›ÛÛX[˜˜[ÙXÚÚ\™\İ[ØXÚHŸ[YT˜[™ÙX™^H—ÙYZÈ—›[Û—YX\ˆ˜8 %œ™\Ú™\ÜÈš[\ˆŸYÙX[X™\˜X™\İ[YÙH‚ˆÈÈÈÑØİ[Y[Ê™\İ[ËÜ[ÛœÏÊX‚‘›Ü›X]ÈÔÙX\˜Ú™\İ[×X[ÈH[›ÜXÈÚ]][ÛœÈTHØİ[Y[Ú\K‚‘˜[È˜XÚÈÈ™\İ[œÛš\]Ú[ˆ™\İ[˜ÛÛ[\È›İÜ[]Y‚‚ˆÈÈÈZ[Ú]Y]Y\J™\İ[Ë]Y\İ[Û‹Ü[ÛœÏÊX‚”™]\›œÈHÛÛ\]HY\ÜØYÙ\Ë˜Ü™X]J
X^[ØY›Üˆ[›ÜXÈ8 %\ÜÈ]Ú]Ü™XY‚‚˜\\ØÜš\˜]ØZ][›ÜXË›Y\ÜØYÙ\Ë˜Ü™X]JÂˆ[Ù[ˆ˜Û]YK\ÛÛ›™]MMˆ‹ˆ‹‹˜Z[Ú]Y]Y\J™\İ[Ë]Y\İ[ÛŠKŸJNÂ˜‚HÈÈš[T™\İ[ØXÚX\œÚ\İÙX\˜Ú™\İ[ÈXÜ›ÜÜÈ›ØÙ\ÜÈ™\İ\Î‚‚˜\\ØÜš\š[\ÜÈ[š[˜ÙYÙX\˜Úš[T™\İ[ØXÚHHœ›ÛHœÙX\˜ÚLÂ˜ÛÛœİÈH™]È[š[˜ÙYÙX\˜Ú
ÂˆØXÚNˆ™]Èš[T™\İ[ØXÚJ‹‹ØØXÚKÜÙX\˜ÚšœÛÛˆ‹Œ
ˆŒ
ˆL
KËÈKZİ\ˆ
BŸJNÂ˜‹KKB‚HÈÈYÚ[ˆTB‚˜\\ØÜš\‹ËÈ™YÚ\İ\ˆHİ\İÛH[™Ú[™BœË\ÙJ^Q[™Ú[™JNÂ‚‹ËÈ\ØX›HHZ[Z[ˆ[™Ú[™BœËœ™[[İ™J›[Ú™YZÈŠNÂ‚‹ËÈ[œÜXİÚ\˜İZ]œ™XZÙ\ˆİ]H\ˆ[™Ú[™B˜ÛÛœÛÛK›ÙÊË›Y]šXÜÊ
JNÂ‹ËÈÈXÚÙXÚÙÛÎˆÈİ]NˆÓÔÑQ‹˜Z[\™\ÎˆKš[™ÎˆÈİ]NˆÓÔÑQ‹˜Z[\™\ÎˆK‹‹ˆB˜‹KKB‚ˆÈÈİÈØÛÜš[™ÈÛÜšÜÂŒKˆ
Š””‘ˆ
ÏLL
JŠˆ8 %ØÛÜ™HH3¨×Ù[™Ú[™HÙZYÚÈ
L
È˜[šÊXˆØ[Xœ˜]Y›ÜˆÛÜœÜ˜HÙˆŒ8 +LL™\İ[ÎÈÏMŒ\È›Üˆ‘PË\ØØ[HL
ÈØÈÛÜœÜ˜H[™\ÈÛÈ›]›ÜˆÙXˆÙX\˜Ú‚Œ‹ˆ
ŠÛÛœÙ[œİ\È›Û\ÊŠˆ8 %™\İ[È\X\š[™È[ˆ][\H[™Ú[™\ÈÙ]ØÛÜ™H0åÈ
H
ÈŒ0­È
\X\˜[˜Ù\È8¢$ŒJJH‚ŒËˆ
Š”\ÜØYÙH“LJŠˆ8 %Ú[ˆ[œšXÚÛÛ[ˆ™]ÚYYÙH^\ÈÜ][Èİ™\›\[™ÈŒ]ÛÜ™Ú[™İÜËˆÚ[™İÜÈX›İ™HH“LH™\ÚÛ\™HÙ[XİY\Ú[™È›Û‹[X^[][Hİ\™\ÜÚ[Ûˆ[™›Ú[™Y[ˆØİ[Y[Ü™\‹‚ˆ
Š“Z[‹[X^›Ü›X[\Ø][ÛŠŠˆ8 %š[˜[ØÛÜ™\ÈØØ[YÈÌWX‚‚‘[™Ú[™HÙZYÚÈ™Y›Xİ[™^]X[]N‚‚˜`/`tavily / google = 1.0
googlenews      = 0.85
duckduckgo      = 0.80
bing            = 0.75
yep             = 0.70
wikipedia       = 0.70
mojeek          = 0.65
marginalia      = 0.62
```

5. **Clustering & Reputation Filter**:
  - **Domain Reputation Filter**: Matches domains against boost lists (authoritative sources) and checks titles and snippets for low-quality/spam regex patterns (deals, affiliate links, clickbait) to scale the authority score component.
  - **Result Clustering**: Groups results into subtopic clusters based on title Jaccard token similarity and selects the highest-scoring representative from each cluster first to ensure query coverage and diversity.

## v3.0.0 â€” Production Release

- **Connection Pool** (`src/core/pool.ts`) â€”Concurrency-limited HTTP pool with request deduplication.
- **pMap** â€”Concurrency-limited parallel mapper for enrichment.
- **Per-Engine Timeouts** â€”Fast engines get shorter timeouts.
- **Trafilatura-Style Extraction** â€” staged content extraction pipeline.
- **SimHash near-duplicate detection** â€”64-bit fingerprint.
- **Semantic Cache** â€”TF-IDF cosine similarity.
- **SSRF Protection** â€”Blocks private IP ranges, validates redirects.
- **IndiaCode + SEBI Engines** â€”Indian legal database adapters.
- **Wikipedia Full-Text** â€”MediaWiki action API.

## v3.1.0 â€” Speed Optimizations & Polish

- *+Early-Return Strategy** â€”`returns as soon as enough results arrive from enough engines`.
- **Tiered Engine Priority** â€”Tier 3 engines only queried with `deep: true`.
- **Streaming Enrichment** â€”`searchWithEnrichment()` async generator.
- **Connection Pre-Warming** â€”QI\ÈPQ™\]Y\İÈÛˆİ\\‚‹H
Š‘UYÈÈÛÛ™][Û˜[ÑU
Šˆ8 %ÌßN Not Modified returns cached content.
- **Content Provenance Metadata** â€”`sourceType`, `authorityScore`, `fsehness` fields.
- **Exponential Backoff** â€”30s â‰ 60tâŠ 120sâŠ¦âŠ¦240s max 10min.
- **Prompt Injection Markers** â€”]`s `[WEB_CONTENT_END]` wrappers.

### v3.1.0 New Exports

```typescript
import { classifySourceType, addProvenance, ENGINE_TIERS } from "search100x";
import type { QueryClassification } from "search100x";
```

## Contributing

Pull requests welcome. To add a new search engine:
1. Create `src/adapters/<name>.ts` implementing `Engine`
2. Add the name to `SourceName` in `src/core/types.ts`
3. Add a weight in `ENGINE_WEIGHTS` in `src/core/scorer.ts`
4. Add one line in `src/search.ts` â†’ initEngines()

```bash
npm run build   # compile
npm test        # build + run all tests
```

---

## License
	MIT Â© 2026 [Rahul - Dharmabot AI](https://dharmabot.ai)
