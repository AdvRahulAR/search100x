import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  startMcpServer,
  handleJsonRpcMessage,
  handleToolCall,
  MCP_TOOLS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_PROTOCOL_VERSION,
  DOMAIN_PRESETS,
  EnhancedSearch,
} from "../dist/index.js";

describe("MCP Server JSON-RPC 2.0 Protocol", () => {
  it("exports all tools and metadata", () => {
    assert.equal(MCP_SERVER_NAME, "search100x");
    assert.equal(MCP_SERVER_VERSION, "4.0.0");
    assert.equal(MCP_PROTOCOL_VERSION, "2024-11-05");
    assert.equal(MCP_TOOLS.length, 4);

    const toolNames = MCP_TOOLS.map((t) => t.name);
    assert.ok(toolNames.includes("web_search"));
    assert.ok(toolNames.includes("legal_search"));
    assert.ok(toolNames.includes("fetch_page_content"));
    assert.ok(toolNames.includes("list_domain_presets"));
  });

  it("handles initialize request", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 1);
    assert.equal(messages[0].result.protocolVersion, "2024-11-05");
    assert.equal(messages[0].result.serverInfo.name, "search100x");
    assert.equal(messages[0].result.serverInfo.version, "4.0.0");
    assert.ok(messages[0].result.capabilities.tools);
  });

  it("handles notifications/initialized without response", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 0);
  });

  it("handles ping request", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "ping-1",
        method: "ping",
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "ping-1");
    assert.deepEqual(messages[0].result, {});
  });

  it("handles tools/list request", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 2);
    assert.equal(messages[0].result.tools.length, 4);
    assert.equal(messages[0].result.tools[0].name, "web_search");
  });

  it("handles list_domain_presets tool call", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_domain_presets",
          arguments: {},
        },
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 3);
    assert.ok(!messages[0].result.isError);
    assert.equal(messages[0].result.content[0].type, "text");
    const parsedPresets = JSON.parse(messages[0].result.content[0].text);
    assert.ok(parsedPresets["india-legal"]);
    assert.ok(parsedPresets["us-legal"]);
  });

  it("handles unknown method with -32601", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "unknown/method",
      }),
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 99);
    assert.equal(messages[0].error.code, -32601);
  });

  it("handles malformed JSON with -32700", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const messages = [];

    await handleJsonRpcMessage(
      "{ invalid json",
      search,
      (msg) => messages.push(msg)
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, null);
    assert.equal(messages[0].error.code, -32700);
  });

  it("handles invalid tool in tools/call", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const res = await handleToolCall("non_existent_tool", {}, search);
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes("Tool not found"));
  });

  it("handles legal_search with invalid jurisdiction gracefully", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const res = await handleToolCall(
      "legal_search",
      { query: "test query", jurisdiction: "mars" },
      search
    );
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes("Unknown legal jurisdiction"));
  });

  it("handles fetch_page_content parameter validation", async () => {
    const search = new EnhancedSearch({ logger: { warn: () => {}, log: () => {}, debug: () => {} } });
    const res = await handleToolCall(
      "fetch_page_content",
      {},
      search
    );
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes("Missing required argument 'url'"));
  });

  it("works over stdio streams using startMcpServer", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = startMcpServer({
      stdin,
      stdout,
      searchConfig: { logger: { warn: () => {}, log: () => {}, debug: () => {} } },
    });

    const received = [];
    stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        received.push(JSON.parse(line));
      }
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "test-stream-1",
        method: "ping",
      }) + "\n"
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(received.length, 1);
    assert.equal(received[0].id, "test-stream-1");
    assert.deepEqual(received[0].result, {});

    server.close();
  });
});
