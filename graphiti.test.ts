import { describe, test, expect, vi, beforeEach } from "vitest";
import { GraphitiClient } from "./graphiti.js";

// ============================================================================
// Test helpers for MCP Streamable HTTP transport
// ============================================================================

const TEST_SESSION_ID = "test-session-abc123";

/** Create an SSE response wrapping a JSON-RPC body */
function sseResponse(body: object, sessionId = TEST_SESSION_ID): Response {
  const sse = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
}

/** Mock the MCP initialization handshake (initialize + notifications/initialized) */
function mockInit(fetchMock: ReturnType<typeof vi.spyOn<[typeof globalThis, "fetch"]>>) {
  // 1. initialize → SSE response with session ID
  fetchMock.mockResolvedValueOnce(
    sseResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: "Graphiti", version: "1.0" },
        protocolVersion: "2024-11-05",
      },
    }),
  );
  // 2. notifications/initialized → 202 Accepted
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
}

// ============================================================================
// Tests
// ============================================================================

describe("GraphitiClient", () => {
  let client: GraphitiClient;

  beforeEach(() => {
    client = new GraphitiClient("http://localhost:8000");
    // Disable background UUID polling by default — tests that need it re-enable
    client.uuidPollMaxAttempts = 0;
    client.uuidPollIntervalMs = 10;
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Health (no MCP session required)
  // --------------------------------------------------------------------------

  test("healthCheck returns true on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("OK", { status: 200 }),
    );

    const ok = await client.healthCheck();
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://localhost:8000/health");
  });

  test("healthCheck returns false on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const ok = await client.healthCheck();
    expect(ok).toBe(false);
  });

  test("healthCheck returns false on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    const ok = await client.healthCheck();
    expect(ok).toBe(false);
  });

  // --------------------------------------------------------------------------
  // MCP Session Initialization
  // --------------------------------------------------------------------------

  test("initializes MCP session on first tool call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test",
      episode_body: "content",
      source_description: "test",
      group_id: "main",
    });

    // First call: initialize
    const initCall = fetchMock.mock.calls[0];
    expect(initCall[0]).toBe("http://localhost:8000/mcp");
    const initBody = JSON.parse(initCall[1]!.body as string);
    expect(initBody.method).toBe("initialize");
    expect(initBody.params.clientInfo.name).toBe("openclaw-memory-graphiti");

    // Second call: notifications/initialized
    const notifCall = fetchMock.mock.calls[1];
    const notifBody = JSON.parse(notifCall[1]!.body as string);
    expect(notifBody.method).toBe("notifications/initialized");

    // Third call: actual tool call with session ID
    const toolCall = fetchMock.mock.calls[2];
    expect((toolCall[1]!.headers as Record<string, string>)["mcp-session-id"]).toBe(TEST_SESSION_ID);
  });

  test("reuses session across multiple tool calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"message":"ok","episodes":[]}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test",
      episode_body: "content",
      source_description: "test",
      group_id: "main",
    });
    await client.getEpisodes("main", 5);

    // Only 4 calls total: init + notif + 2 tool calls (not 6)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // --------------------------------------------------------------------------
  // Episodes
  // --------------------------------------------------------------------------

  test("addEpisode calls add_memory and generates UUID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"Episode queued"}' }], isError: false },
      }),
    );

    const result = await client.addEpisode({
      name: "test_episode",
      episode_body: "Mark got a promotion",
      source_description: "conversation with Mark",
      group_id: "family",
    });

    // UUID is generated client-side
    expect(result.episode_uuid).toBeDefined();
    expect(result.episode_uuid).toMatch(/^[0-9a-f-]{36}$/);

    // Tool call is the 3rd fetch (after init + notif)
    const call = fetchMock.mock.calls[2];
    expect(call[0]).toBe("http://localhost:8000/mcp");
    const body = JSON.parse(call[1]!.body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("add_memory");
    expect(body.params.arguments.name).toBe("test_episode");
    expect(body.params.arguments.episode_body).toBe("Mark got a promotion");
    expect(body.params.arguments.group_id).toBe("family");
    // UUID is NOT sent to server (server's uuid param is for re-processing existing episodes)
    expect(body.params.arguments.uuid).toBeUndefined();
  });

  test("addEpisode ignores provided UUID (deprecated)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    const result = await client.addEpisode({
      name: "test",
      episode_body: "content",
      group_id: "main",
      uuid: "my-custom-uuid",
    });

    // Client generates its own tracking UUID, ignores provided one
    expect(result.episode_uuid).toBeDefined();
    expect(result.episode_uuid).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    // UUID is NOT sent to server
    expect(body.params.arguments.uuid).toBeUndefined();
  });

  test("addEpisode passes source parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test_message",
      episode_body: "User: hello\nAssistant: hi",
      group_id: "main",
      source: "message",
    });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.source).toBe("message");
  });

  test("addEpisode prepends custom_extraction_instructions to episode_body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test",
      episode_body: "Mark got a promotion",
      group_id: "main",
      custom_extraction_instructions: "Extract names and roles",
    });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    // Instructions are prepended to episode_body with delimiters
    expect(body.params.arguments.episode_body).toContain("[Extraction Instructions]");
    expect(body.params.arguments.episode_body).toContain("Extract names and roles");
    expect(body.params.arguments.episode_body).toContain("[End Instructions]");
    expect(body.params.arguments.episode_body).toContain("Mark got a promotion");
    // Not sent as a separate argument
    expect(body.params.arguments.custom_extraction_instructions).toBeUndefined();
  });

  test("addEpisode leaves episode_body unchanged when no custom instructions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test",
      episode_body: "plain content",
      group_id: "main",
    });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.episode_body).toBe("plain content");
    expect(body.params.arguments.episode_body).not.toContain("[Extraction Instructions]");
  });

  test("addEpisode drops deprecated uuid and reference_time params", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    await client.addEpisode({
      name: "test",
      episode_body: "content",
      group_id: "main",
      uuid: "should-be-dropped",
      reference_time: "2026-01-15T00:00:00Z",
    });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.uuid).toBeUndefined();
    expect(body.params.arguments.reference_time).toBeUndefined();
  });

  test("addEpisode returns resolvedUuid promise", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    const result = await client.addEpisode({
      name: "test",
      episode_body: "content",
      group_id: "main",
    });

    // resolvedUuid should be a promise
    expect(result.resolvedUuid).toBeInstanceOf(Promise);
    // With polling disabled (maxAttempts=0), it rejects
    await expect(result.resolvedUuid).rejects.toThrow("Failed to resolve episode UUID");
  });

  test("resolvedUuid resolves to real server-side UUID via polling", async () => {
    // Re-enable polling for this test
    client.uuidPollMaxAttempts = 3;
    client.uuidPollIntervalMs = 10;

    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);

    // 1st fetch after init: add_memory response
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    // 2nd fetch: getEpisodes poll — episode not ready yet
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"episodes":[]}' }], isError: false },
      }),
    );

    // 3rd fetch: getEpisodes poll — episode now available with real UUID
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              episodes: [{
                uuid: "real-server-uuid-123",
                name: "my_episode",
                content: "content",
                source_description: "test",
                group_id: "main",
                created_at: "2026-02-10T00:00:00Z",
              }],
            }),
          }],
          isError: false,
        },
      }),
    );

    const result = await client.addEpisode({
      name: "my_episode",
      episode_body: "content",
      group_id: "main",
    });

    // Tracking UUID is immediate
    expect(result.episode_uuid).toMatch(/^[0-9a-f-]{36}$/);

    // resolvedUuid polls and finds the real UUID
    const realUuid = await result.resolvedUuid;
    expect(realUuid).toBe("real-server-uuid-123");
    expect(realUuid).not.toBe(result.episode_uuid);
  });

  test("resolvedUuid resolves immediately when no group_id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
      }),
    );

    const result = await client.addEpisode({
      name: "test",
      episode_body: "content",
      // No group_id — can't poll, so resolvedUuid = trackingUuid
    });

    const resolved = await result.resolvedUuid;
    expect(resolved).toBe(result.episode_uuid);
  });

  test("getEpisodes sends group_ids and max_episodes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"ok","episodes":[]}' }], isError: false },
      }),
    );

    await client.getEpisodes("family", 5);

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.group_ids).toEqual(["family"]);
    expect(body.params.arguments.max_episodes).toBe(5);
  });

  test("deleteEpisode sends uuid parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"deleted"}' }], isError: false },
      }),
    );

    await client.deleteEpisode("ep-456");

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("delete_episode");
    expect(body.params.arguments.uuid).toBe("ep-456");
  });

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  test("searchNodes sends group_ids and max_nodes, parses nodes array", async () => {
    const nodes = [
      { uuid: "n1", name: "Mark", summary: "A person", group_id: "family", labels: [], created_at: "2026-01-15", attributes: {} },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ message: "Found 1 node", nodes }) }],
          isError: false,
        },
      }),
    );

    const result = await client.searchNodes({ query: "Mark", group_id: "family", limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Mark");

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("search_nodes");
    expect(body.params.arguments.group_ids).toEqual(["family"]);
    expect(body.params.arguments.max_nodes).toBe(5);
  });

  test("searchNodes accepts group_ids array directly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"ok","nodes":[]}' }], isError: false },
      }),
    );

    await client.searchNodes({ query: "test", group_ids: ["g1", "g2"] });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.group_ids).toEqual(["g1", "g2"]);
  });

  test("searchFacts calls search_memory_facts with group_ids", async () => {
    const facts = [
      { uuid: "f1", fact: "Mark works at Acme", source_node_name: "Mark", target_node_name: "Acme", group_id: "family", created_at: "2026-01-15" },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ message: "Found 1 fact", facts }) }],
          isError: false,
        },
      }),
    );

    const result = await client.searchFacts({ query: "promotion", group_id: "family", limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe("Mark works at Acme");

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("search_memory_facts");
    expect(body.params.arguments.group_ids).toEqual(["family"]);
    expect(body.params.arguments.max_facts).toBe(5);
  });

  // --------------------------------------------------------------------------
  // Response format handling
  // --------------------------------------------------------------------------

  test("handles plain JSON responses (non-SSE)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: '{"message":"queued"}' }], isError: false },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "mcp-session-id": TEST_SESSION_ID,
          },
        },
      ),
    );

    const result = await client.addEpisode({
      name: "test",
      episode_body: "content",
      group_id: "main",
    });
    expect(result.episode_uuid).toBeDefined();
  });

  test("returns empty array when search result missing key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"error"}' }], isError: true },
      }),
    );

    const result = await client.searchNodes({ query: "test", group_id: "main" });
    expect(result).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Errors
  // --------------------------------------------------------------------------

  test("throws on HTTP error from tool call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(
      client.addEpisode({
        name: "x",
        episode_body: "x",
        group_id: "x",
      }),
    ).rejects.toThrow("Graphiti MCP server error: 500");
  });

  test("throws on JSON-RPC error in SSE response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: "Method not found" },
      }),
    );

    await expect(
      client.searchNodes({ query: "test", group_id: "main" }),
    ).rejects.toThrow("Graphiti tool search_nodes failed: Method not found");
  });

  test("throws on MCP init failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    await expect(
      client.addEpisode({
        name: "x",
        episode_body: "x",
        group_id: "x",
      }),
    ).rejects.toThrow("Graphiti MCP init failed: 503");
  });

  // --------------------------------------------------------------------------
  // Entity Edge Operations
  // --------------------------------------------------------------------------

  test("getEntityEdge sends uuid and parses single fact", async () => {
    const fact = {
      uuid: "edge-1",
      fact: "Mark works at Acme",
      source_node_name: "Mark",
      target_node_name: "Acme",
      group_id: "family",
      created_at: "2026-01-15",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify(fact) }],
          isError: false,
        },
      }),
    );

    const result = await client.getEntityEdge("edge-1");
    expect(result.uuid).toBe("edge-1");
    expect(result.fact).toBe("Mark works at Acme");

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("get_entity_edge");
    expect(body.params.arguments.uuid).toBe("edge-1");
  });

  test("deleteEntityEdge sends uuid", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"deleted"}' }], isError: false },
      }),
    );

    await client.deleteEntityEdge("edge-1");

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("delete_entity_edge");
    expect(body.params.arguments.uuid).toBe("edge-1");
  });

  test("clearGraph sends group_ids when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"cleared"}' }], isError: false },
      }),
    );

    await client.clearGraph(["g1", "g2"]);

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("clear_graph");
    expect(body.params.arguments.group_ids).toEqual(["g1", "g2"]);
  });

  test("clearGraph sends empty args when no groupIds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"cleared"}' }], isError: false },
      }),
    );

    await client.clearGraph();

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.name).toBe("clear_graph");
    expect(body.params.arguments.group_ids).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // New search parameters
  // --------------------------------------------------------------------------

  test("searchNodes passes entity_types parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"ok","nodes":[]}' }], isError: false },
      }),
    );

    await client.searchNodes({ query: "test", group_id: "g1", entity_types: ["Preference", "Organization"] });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.entity_types).toEqual(["Preference", "Organization"]);
  });

  test("searchNodes omits entity_types when empty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"ok","nodes":[]}' }], isError: false },
      }),
    );

    await client.searchNodes({ query: "test", group_id: "g1", entity_types: [] });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.entity_types).toBeUndefined();
  });

  test("searchFacts passes center_node_uuid parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mockInit(fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: '{"message":"ok","facts":[]}' }], isError: false },
      }),
    );

    await client.searchFacts({ query: "test", group_id: "g1", center_node_uuid: "node-uuid-123" });

    const body = JSON.parse(fetchMock.mock.calls[2][1]!.body as string);
    expect(body.params.arguments.center_node_uuid).toBe("node-uuid-123");
  });
});
