/**
 * search100x MCP Server
 *
 * Implements standard JSON-RPC 2.0 over stdio for Model Context Protocol (MCP).
 * Provides LLMs with live web search, jurisdiction-aware legal search,
 * content fetching with BM25 extraction, and domain preset inspection.
 */

import * as readline from "node:readline";
import { EnhancedSearch, DOMAIN_PRESETS } from "./search.js";
import { SearchConfig, TimeRange } from "./core/types.js";
import { fetchPageContent, fetchRelevantContent } from "./core/fetcher.js";

// ── MCP Server Constants ─────────────────────────────────────────────────────

export const MCP_SERVER_NAME = "search100x";
export const MCP_SERVER_VERSION = "4.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCP_DEFAULT_SEARCH_LIMIT = 10;
export const MCP_MAX_SEARCH_LIMIT = 100;
export const MCP_DEFAULT_FETCH_MAX_CHARS = 3000;
export const MCP_DEFAULT_FETCH_TIMEOUT_MS = 6000;
export const MCP_DEFAULT_SEARCH_TIMEOUT_MS = 10000;

export const JURISDICTION_TO_PRESET_MAP: Record<string, string> = {
  india: "india-legal",
  us: "us-legal",
  uk: "uk-legal",
  eu: "eu-legal",
  au: "au-legal",
  sg: "sg-legal",
};

// ── MCP Type Definitions ─────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, McpToolProperty>;
  required?: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  searchConfig?: SearchConfig;
}

export interface McpServerInstance {
  close: () => void;
}

// ── MCP Tool Definitions ─────────────────────────────────────────────────────

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "web_search",
    description: "Multi-engine web search with optional domain presets, content enrichment, and time filtering",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 100)",
        },
        preset: {
          type: "string",
          description: "Domain preset name (india-legal | us-legal | uk-legal | eu-legal | au-legal | sg-legal | academic)",
        },
        enrichContent: {
          type: "number",
          description: "Number of top results to enrich with full extracted page content (default: 0)",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Time range filter for results (day | week | month | year)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "legal_search",
    description: "Jurisdiction-focused legal search across statutes, case law, and regulatory portals",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Legal search query (e.g. statutes, sections, case names, regulatory rules)",
        },
        jurisdiction: {
          type: "string",
          enum: ["india", "us", "uk", "eu", "au", "sg"],
          description: "Target legal jurisdiction (india | us | uk | eu | au | sg, default: india)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 100)",
        },
        enrichContent: {
          type: "number",
          description: "Number of top results to enrich with legal passage extraction (default: 0)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_page_content",
    description: "Fetch and extract clean readable text or BM25-relevant passages from a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL of the webpage to fetch content from",
        },
        query: {
          type: "string",
          description: "Optional query to extract the most relevant passages via BM25 matching",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to extract (default: 3000)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_domain_presets",
    description: "List all available domain presets and their constituent domains for scoped searching",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Parameter Parsing Helpers ────────────────────────────────────────────────

interface WebSearchParams {
  query: string;
  limit: number;
  preset?: string;
  enrichContent: number;
  timeRange?: TimeRange;
}

function parseWebSearchParams(args: unknown): WebSearchParams {
  if (typeof args !== "object" || args === null) {
    throw new Error("Invalid arguments: expected an object");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.query !== "string" || !record.query.trim()) {
    throw new Error("Missing required argument 'query'");
  }
  const query = record.query.trim();

  let limit = MCP_DEFAULT_SEARCH_LIMIT;
  if (typeof record.limit === "number" && !isNaN(record.limit)) {
    limit = Math.max(1, Math.min(MCP_MAX_SEARCH_LIMIT, Math.floor(record.limit)));
  }

  const preset = typeof record.preset === "string" && record.preset.trim()
    ? record.preset.trim()
    : undefined;

  let enrichContent = 0;
  if (typeof record.enrichContent === "number" && !isNaN(record.enrichContent)) {
    enrichContent = Math.max(0, Math.floor(record.enrichContent));
  }

  const validTimeRanges: TimeRange[] = ["day", "week", "month", "year"];
  const timeRange = typeof record.timeRange === "string" && validTimeRanges.includes(record.timeRange as TimeRange)
    ? (record.timeRange as TimeRange)
    : undefined;

  return { query, limit, preset, enrichContent, timeRange };
}

interface LegalSearchParams {
  query: string;
  jurisdiction: string;
  limit: number;
  enrichContent: number;
}

function parseLegalSearchParams(args: unknown): LegalSearchParams {
  if (typeof args !== "object" || args === null) {
    throw new Error("Invalid arguments: expected an object");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.query !== "string" || !record.query.trim()) {
    throw new Error("Missing required argument 'query'");
  }
  const query = record.query.trim();

  const jurisdiction = typeof record.jurisdiction === "string" && record.jurisdiction.trim()
    ? record.jurisdiction.trim().toLowerCase()
    : "india";

  let limit = MCP_DEFAULT_SEARCH_LIMIT;
  if (typeof record.limit === "number" && !isNaN(record.limit)) {
    limit = Math.max(1, Math.min(MCP_MAX_SEARCH_LIMIT, Math.floor(record.limit)));
  }

  let enrichContent = 0;
  if (typeof record.enrichContent === "number" && !isNaN(record.enrichContent)) {
    enrichContent = Math.max(0, Math.floor(record.enrichContent));
  }

  return { query, jurisdiction, limit, enrichContent };
}

interface FetchPageContentParams {
  url: string;
  query?: string;
  maxChars: number;
}

function parseFetchPageContentParams(args: unknown): FetchPageContentParams {
  if (typeof args !== "object" || args === null) {
    throw new Error("Invalid arguments: expected an object");
  }
  const record = args as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url.trim()) {
    throw new Error("Missing required argument 'url'");
  }
  const url = record.url.trim();

  const query = typeof record.query === "string" && record.query.trim()
    ? record.query.trim()
    : undefined;

  let maxChars = MCP_DEFAULT_FETCH_MAX_CHARS;
  if (typeof record.maxChars === "number" && !isNaN(record.maxChars)) {
    maxChars = Math.max(50, Math.floor(record.maxChars));
  }

  return { url, query, maxChars };
}

// ── Tool Execution Handler ───────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: unknown,
  search: EnhancedSearch
): Promise<McpToolCallResult> {
  switch (name) {
    case "web_search": {
      try {
        const params = parseWebSearchParams(args);
        let scopedDomains: string[] | undefined;
        let scoringPreset: "default" | "news" | "legal" | "academic" | undefined;

        if (params.preset) {
          scopedDomains = DOMAIN_PRESETS[params.preset];
          if (!scopedDomains) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Unknown preset "${params.preset}". Available presets: ${Object.keys(DOMAIN_PRESETS).join(", ")}`,
                },
              ],
            };
          }
          if (params.preset.includes("legal")) {
            scoringPreset = "legal";
          } else if (params.preset === "academic") {
            scoringPreset = "academic";
          }
        }

        const response = await search.search(params.query, {
          limit: params.limit,
          scopedDomains,
          enrichContent: params.enrichContent,
          timeRange: params.timeRange,
          scoringPreset,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `web_search error: ${errorMsg}`,
            },
          ],
        };
      }
    }

    case "legal_search": {
      try {
        const params = parseLegalSearchParams(args);
        const normalizedKey = params.jurisdiction.replace(/-legal$/, "");
        const presetKey = JURISDICTION_TO_PRESET_MAP[normalizedKey] ?? (DOMAIN_PRESETS[params.jurisdiction] ? params.jurisdiction : undefined);

        if (!presetKey || !DOMAIN_PRESETS[presetKey]) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown legal jurisdiction "${params.jurisdiction}". Available jurisdictions: ${Object.keys(JURISDICTION_TO_PRESET_MAP).join(", ")}`,
              },
            ],
          };
        }

        const scopedDomains = DOMAIN_PRESETS[presetKey];
        const response = await search.search(params.query, {
          limit: params.limit,
          scopedDomains,
          enrichContent: params.enrichContent,
          scoringPreset: "legal",
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `legal_search error: ${errorMsg}`,
            },
          ],
        };
      }
    }

    case "fetch_page_content": {
      try {
        const params = parseFetchPageContentParams(args);
        let content: string | undefined;

        if (params.query) {
          content = await fetchRelevantContent(params.url, params.query, {
            maxChars: params.maxChars,
            timeoutMs: MCP_DEFAULT_FETCH_TIMEOUT_MS,
          });
        }

        if (!content) {
          content = await fetchPageContent(params.url, MCP_DEFAULT_FETCH_TIMEOUT_MS, params.maxChars);
        }

        if (!content || !content.trim()) {
          return {
            content: [
              {
                type: "text",
                text: `No readable content could be extracted from "${params.url}". The page may be blocked, require authentication, or contain unsupported media.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `fetch_page_content error: ${errorMsg}`,
            },
          ],
        };
      }
    }

    case "list_domain_presets": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(DOMAIN_PRESETS, null, 2),
          },
        ],
      };
    }

    default: {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool not found: "${name}"`,
          },
        ],
      };
    }
  }
}

// ── JSON-RPC Message Dispatcher ──────────────────────────────────────────────

export async function handleJsonRpcMessage(
  rawMessage: string,
  search: EnhancedSearch,
  sendMessage: (response: JsonRpcResponse) => void
): Promise<void> {
  const trimmed = rawMessage.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Malformed JSON string";
    sendMessage({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${errorMsg}`,
      },
    });
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendMessage({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request: expected a JSON object",
      },
    });
    return;
  }

  const req = parsed as Record<string, unknown>;
  const id = (typeof req.id === "string" || typeof req.id === "number" || req.id === null)
    ? req.id
    : undefined;
  const isNotification = id === undefined;
  const method = typeof req.method === "string" ? req.method : "";
  const params = typeof req.params === "object" && req.params !== null && !Array.isArray(req.params)
    ? (req.params as Record<string, unknown>)
    : {};

  if (!method) {
    if (!isNotification) {
      sendMessage({
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: -32600,
          message: "Invalid Request: missing or invalid 'method'",
        },
      });
    }
    return;
  }

  try {
    switch (method) {
      case "initialize": {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: MCP_SERVER_VERSION,
            },
          },
        };
        sendMessage(response);
        break;
      }

      case "notifications/initialized":
      case "initialized": {
        if (!isNotification) {
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {},
          });
        }
        break;
      }

      case "ping": {
        if (!isNotification) {
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {},
          });
        }
        break;
      }

      case "tools/list": {
        if (!isNotification) {
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: {
              tools: MCP_TOOLS,
            },
          });
        }
        break;
      }

      case "tools/call": {
        const toolName = typeof params.name === "string" ? params.name : "";
        const toolArgs = params.arguments;

        if (!toolName) {
          if (!isNotification) {
            sendMessage({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: "Invalid params: missing tool 'name'",
              },
            });
          }
          return;
        }

        const toolResult = await handleToolCall(toolName, toolArgs, search);
        if (!isNotification) {
          sendMessage({
            jsonrpc: "2.0",
            id,
            result: toolResult,
          });
        }
        break;
      }

      default: {
        if (!isNotification) {
          sendMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
        }
        break;
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[search100x-mcp] Error handling method ${method}: ${errorMsg}`);
    if (!isNotification) {
      sendMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Internal error: ${errorMsg}`,
        },
      });
    }
  }
}

// ── MCP Server Lifecycle ─────────────────────────────────────────────────────

export function startMcpServer(options: McpServerOptions = {}): McpServerInstance {
  const inputStream = options.stdin ?? process.stdin;
  const outputStream = options.stdout ?? process.stdout;

  const search = new EnhancedSearch({
    braveApiKey: process.env.BRAVE_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleCx: process.env.GOOGLE_CX,
    timeoutMs: Number(process.env.TIMEOUT_MS ?? MCP_DEFAULT_SEARCH_TIMEOUT_MS),
    newsRegion: process.env.NEWS_REGION ?? "US",
    logger: {
      warn: (msg: string) => console.error(`[search100x-mcp] WARN: ${msg}`),
      log: (msg: string) => console.error(`[search100x-mcp] INFO: ${msg}`),
      debug: () => {},
    },
    ...options.searchConfig,
  });

  const rl = readline.createInterface({
    input: inputStream,
    terminal: false,
  });

  const sendMessage = (msg: JsonRpcResponse): void => {
    outputStream.write(JSON.stringify(msg) + "\n");
  };

  rl.on("line", (line: string) => {
    handleJsonRpcMessage(line, search, sendMessage).catch((err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[search100x-mcp] Unexpected error processing message: ${errorMsg}`);
    });
  });

  rl.on("close", () => {
    // stdio closed, cleanup if needed
  });

  return {
    close: () => {
      rl.close();
    },
  };
}
