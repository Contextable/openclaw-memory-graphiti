/**
 * Memory Plugin (Graphiti + SpiceDB) Tests
 *
 * Tests plugin registration, configuration, tool wiring,
 * and lifecycle hooks with mocked backends.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock @authzed/authzed-node before importing the plugin
vi.mock("@authzed/authzed-node", () => {
  const mockPromises = {
    writeSchema: vi.fn().mockResolvedValue({}),
    readSchema: vi.fn().mockResolvedValue({ schemaText: "" }),
    writeRelationships: vi.fn().mockResolvedValue({ writtenAt: { token: "write-token-1" } }),
    deleteRelationships: vi.fn().mockResolvedValue({ deletedAt: { token: "delete-token" } }),
    bulkImportRelationships: vi.fn(),
    checkPermission: vi.fn().mockResolvedValue({
      permissionship: 2, // HAS_PERMISSION
    }),
    lookupResources: vi.fn().mockResolvedValue([
      { resourceObjectId: "main" },
    ]),
    readRelationships: vi.fn().mockResolvedValue([]),
  };

  return {
    v1: {
      NewClient: vi.fn(() => ({
        promises: mockPromises,
      })),
      ClientSecurity: { INSECURE_LOCALHOST_ALLOWED: 1 },
      WriteSchemaRequest: { create: vi.fn((v: unknown) => v) },
      ReadSchemaRequest: { create: vi.fn((v: unknown) => v) },
      WriteRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      DeleteRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      RelationshipFilter: { create: vi.fn((v: unknown) => v) },
      CheckPermissionRequest: { create: vi.fn((v: unknown) => v) },
      CheckPermissionResponse_Permissionship: { HAS_PERMISSION: 2 },
      LookupResourcesRequest: { create: vi.fn((v: unknown) => v) },
      ReadRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      SubjectFilter: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate_Operation: { TOUCH: 1, DELETE: 2 },
      Relationship: { create: vi.fn((v: unknown) => v) },
      ObjectReference: { create: vi.fn((v: unknown) => v) },
      SubjectReference: { create: vi.fn((v: unknown) => v) },
      BulkImportRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      Consistency: { create: vi.fn((v: unknown) => v) },
      ZedToken: { create: vi.fn((v: unknown) => v) },
    },
  };
});

// ============================================================================
// MCP Streamable HTTP mock helpers
// ============================================================================

const mockFetch = vi.fn();

/** Create an SSE response wrapping a JSON-RPC body */
function makeSseResponse(body: object): Response {
  const sse = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(sse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "mcp-session-id": "mock-session-123",
    },
  });
}

/**
 * Configure mockFetch to handle the MCP Streamable HTTP protocol:
 * - Returns SSE init response for `initialize` calls
 * - Returns 202 for `notifications/initialized`
 * - Returns OK for `/health` checks
 * - Returns SSE response with `textPayload` wrapped in MCP content blocks for tool calls
 */
function setupGraphitiMock(textPayload = '{"message":"ok"}') {
  mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
    // Health check
    if (typeof url === "string" && url.endsWith("/health")) {
      return Promise.resolve(new Response("OK", { status: 200 }));
    }

    const body = init?.body ? JSON.parse(init.body as string) : {};

    // MCP initialization handshake
    if (body.method === "initialize") {
      return Promise.resolve(makeSseResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          capabilities: { tools: {} },
          serverInfo: { name: "Graphiti", version: "1.0" },
          protocolVersion: "2024-11-05",
        },
      }));
    }

    // Initialized notification
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }

    // Tool calls — return SSE with MCP content-wrapped result
    return Promise.resolve(makeSseResponse({
      jsonrpc: "2.0",
      id: body.id || 1,
      result: {
        content: [{ type: "text", text: textPayload }],
        isError: false,
      },
    }));
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("memory-graphiti plugin", () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredTools: any[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredClis: any[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredServices: any[];
  // oxlint-disable-next-line typescript/no-explicit-any
  let registeredHooks: Record<string, any[]>;
  let logs: string[];

  // oxlint-disable-next-line typescript/no-explicit-any
  let mockApi: any;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    registeredTools = [];
    registeredClis = [];
    registeredServices = [];
    registeredHooks = {};
    logs = [];

    // Reset SpiceDB checkPermission mock to default (HAS_PERMISSION)
    // This is needed because vi.restoreAllMocks() doesn't reset vi.fn() mocks
    // created inside vi.mock() callbacks — tests that modify checkPermission
    // would otherwise leak their mock implementation to subsequent tests.
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockResolvedValue({ permissionship: 2 });
    mockClient.promises.lookupResources.mockResolvedValue([{ resourceObjectId: "main" }]);
    mockClient.promises.writeRelationships.mockResolvedValue({ writtenAt: { token: "write-token-1" } });
    mockClient.promises.deleteRelationships.mockResolvedValue({ deletedAt: { token: "delete-token" } });

    mockApi = {
      id: "memory-graphiti",
      name: "Memory (Graphiti + SpiceDB)",
      source: "test",
      config: {},
      pluginConfig: {
        spicedb: {
          endpoint: "localhost:50051",
          token: "test-token",
          insecure: true,
        },
        graphiti: {
          endpoint: "http://localhost:8000",
          defaultGroupId: "main",
        },
        subjectType: "agent",
        subjectId: "test-agent",
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => registeredTools.push({ tool, opts }),
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: (registrar: any, opts: any) => registeredClis.push({ registrar, opts }),
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (service: any) => registeredServices.push(service),
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // Setup global fetch mock with default MCP protocol handling
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);
    setupGraphitiMock();
  });

  test("plugin exports correct metadata", async () => {
    const { default: plugin } = await import("./index.js");

    expect(plugin.id).toBe("memory-graphiti");
    expect(plugin.name).toBe("Memory (Graphiti + SpiceDB)");
    expect(plugin.kind).toBe("memory");
    expect(plugin.configSchema).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    expect(plugin.register).toBeInstanceOf(Function);
  });

  test("registers 4 tools, 1 CLI group, 1 service", async () => {
    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    expect(registeredTools).toHaveLength(4);
    const toolNames = registeredTools.map((t) => t.opts?.name);
    expect(toolNames).toContain("memory_recall");
    expect(toolNames).toContain("memory_store");
    expect(toolNames).toContain("memory_forget");
    expect(toolNames).toContain("memory_status");

    expect(registeredClis).toHaveLength(1);
    expect(registeredClis[0].opts).toEqual({ commands: ["graphiti-mem"] });

    expect(registeredServices).toHaveLength(1);
    expect(registeredServices[0].id).toBe("memory-graphiti");
  });

  test("registers hooks when autoRecall and autoCapture enabled", async () => {
    mockApi.pluginConfig.autoRecall = true;
    mockApi.pluginConfig.autoCapture = true;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    expect(registeredHooks["before_agent_start"]).toHaveLength(1);
    expect(registeredHooks["agent_end"]).toHaveLength(1);
  });

  test("does not register hooks when autoRecall and autoCapture disabled", async () => {
    mockApi.pluginConfig.autoRecall = false;
    mockApi.pluginConfig.autoCapture = false;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    expect(registeredHooks["before_agent_start"]).toBeUndefined();
    expect(registeredHooks["agent_end"]).toBeUndefined();
  });

  test("memory_recall tool returns results with scope support", async () => {
    // Mock Graphiti search response — needs both nodes and facts keys
    const nodes = [
      { uuid: "n1", name: "Mark", summary: "Mark is a developer", group_id: "main", labels: [], created_at: "2026-01-15T00:00:00Z", attributes: {} },
    ];
    setupGraphitiMock(JSON.stringify({ message: "Found 1 node", nodes, facts: [] }));

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const result = await recallTool.execute("call-1", { query: "Mark work", limit: 5, scope: "all" });

    expect(result.details.count).toBeGreaterThanOrEqual(1);
    expect(result.details.authorizedGroups).toBeDefined();
    expect(result.details.longTermCount).toBeDefined();
    expect(result.details.sessionCount).toBeDefined();
  });

  test("memory_store tool creates episode with UUID", async () => {
    setupGraphitiMock('{"message":"Episode queued"}');

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const result = await storeTool.execute("call-2", {
      content: "Mark got a promotion at work",
      source_description: "conversation with Mark",
      involves: ["mark"],
      group_id: "family",
    });

    expect(result.details.action).toBe("created");
    expect(result.details.episodeId).toBeDefined();
    expect(result.details.episodeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.details.groupId).toBe("family");
    expect(result.details.longTerm).toBe(true);

    // Verify add_memory tool was called
    const fetchCalls = mockFetch.mock.calls;
    const addMemoryCall = fetchCalls.find((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCall).toBeDefined();
    const body = JSON.parse(addMemoryCall![1]?.body as string);
    expect(body.params.arguments.group_id).toBe("family");
    // custom_extraction_instructions are prepended to episode_body
    expect(body.params.arguments.episode_body).toContain("[Extraction Instructions]");
    expect(body.params.arguments.episode_body).toContain("Mark got a promotion at work");
    expect(body.params.arguments.custom_extraction_instructions).toBeUndefined();
  });

  test("memory_store tool uses session group when longTerm=false", async () => {
    setupGraphitiMock('{"message":"queued"}');

    // Enable autoRecall so the before_agent_start hook fires and sets sessionId
    mockApi.pluginConfig.autoRecall = true;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    // Simulate session ID being set via before_agent_start hook
    const beforeHook = registeredHooks["before_agent_start"]?.[0];
    if (beforeHook) {
      await beforeHook({ prompt: "hello world test prompt" }, { sessionKey: "sess-123" });
    }

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const result = await storeTool.execute("call-session", {
      content: "This is session context",
      longTerm: false,
    });

    expect(result.details.action).toBe("created");
    expect(result.details.groupId).toBe("session-sess-123");
    expect(result.details.longTerm).toBe(false);
  });

  test("session group ID sanitizes colons in sessionKey", async () => {
    setupGraphitiMock('{"message":"queued"}');

    mockApi.pluginConfig.autoRecall = true;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    // OpenClaw gateway sends sessionKey like "agent:main:main" — colons are invalid in Graphiti group_ids
    const beforeHook = registeredHooks["before_agent_start"]?.[0];
    if (beforeHook) {
      await beforeHook({ prompt: "test" }, { sessionKey: "agent:main:main" });
    }

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const result = await storeTool.execute("call-sanitized", {
      content: "Session with colons in key",
      longTerm: false,
    });

    expect(result.details.groupId).toBe("session-agent-main-main");
  });

  test("memory_forget tool checks permission before deleting", async () => {
    setupGraphitiMock('{"message":"deleted"}');

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-3", { episode_id: "ep-123" });

    expect(result.details.action).toBe("deleted");
    expect(result.details.episodeId).toBe("ep-123");
  });

  test("memory_store denies write to unauthorized non-session group", async () => {
    setupGraphitiMock('{"message":"queued"}');

    // Make checkPermission deny "contribute" but allow "delete"
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "contribute") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 }); // HAS_PERMISSION
    });

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const result = await storeTool.execute("call-denied", {
      content: "Trying to inject false memories",
      group_id: "family",
    });

    expect(result.details.action).toBe("denied");
    expect(result.details.groupId).toBe("family");

    // Verify Graphiti was NOT called (no add_memory fetch after initialize)
    const addMemoryCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCalls).toHaveLength(0);
  });

  test("memory_store allows write to own current session group", async () => {
    setupGraphitiMock('{"message":"queued"}');

    // Make checkPermission deny contribute — should NOT matter for OWN session
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockImplementation(() => {
      return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION for everything
    });

    mockApi.pluginConfig.autoRecall = true;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    // Set session ID via hook — establishes "sess-write" as the agent's own session
    const beforeHook = registeredHooks["before_agent_start"]?.[0];
    if (beforeHook) {
      await beforeHook({ prompt: "test prompt for session" }, { sessionKey: "sess-write" });
    }

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const result = await storeTool.execute("call-session-write", {
      content: "Session memory content",
      longTerm: false,
    });

    // Should succeed — own session group auto-creates membership
    expect(result.details.action).toBe("created");
    expect(result.details.groupId).toBe("session-sess-write");
  });

  test("memory_store denies write to foreign session group", async () => {
    setupGraphitiMock('{"message":"queued"}');

    // Make checkPermission deny contribute
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "contribute") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 });
    });

    mockApi.pluginConfig.autoRecall = true;

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    // Set this agent's session to "my-session"
    const beforeHook = registeredHooks["before_agent_start"]?.[0];
    if (beforeHook) {
      await beforeHook({ prompt: "test" }, { sessionKey: "my-session" });
    }

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;

    // Try to write to a DIFFERENT agent's session group
    const result = await storeTool.execute("call-foreign-session", {
      content: "Injecting into another agent's session",
      group_id: "session-other-agents-session",
    });

    // Should be denied — not the agent's own session, and no contribute permission
    expect(result.details.action).toBe("denied");
    expect(result.details.groupId).toBe("session-other-agents-session");

    // Verify Graphiti was NOT called
    const addMemoryCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCalls).toHaveLength(0);
  });

  test("auto-capture skips write when permission denied for non-session group", async () => {
    mockApi.pluginConfig.autoCapture = true;
    setupGraphitiMock('{"message":"queued"}');

    // Make checkPermission deny contribute
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "contribute") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 });
    });

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const agentEndHook = registeredHooks["agent_end"]?.[0];
    expect(agentEndHook).toBeDefined();

    // No sessionKey → falls back to default group (non-session) → write check fires
    await agentEndHook({
      success: true,
      messages: [
        { role: "user", content: "Some info to capture" },
        { role: "assistant", content: "Got it!" },
      ],
    }, {});

    // Verify add_memory was NOT called
    const addMemoryCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCalls).toHaveLength(0);

    // Should log the denial
    expect(logs.some((l) => l.includes("auto-capture denied"))).toBe(true);
  });

  test("memory_status tool reports session ID", async () => {
    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const statusTool = registeredTools.find((t) => t.opts?.name === "memory_status")?.tool;
    const result = await statusTool.execute("call-4", {});

    expect(result.details.graphiti).toBe("connected");
    expect(result.details.spicedb).toBe("connected");
    expect(result.details.currentSessionId).toBe("none");
  });

  test("threads ZedToken from synchronous write to subsequent read for causal consistency", async () => {
    setupGraphitiMock('{"message":"queued"}');

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    // 1. Start the service — ensureGroupMembership writes a group membership
    //    relationship synchronously, setting lastWriteToken.
    const service = registeredServices[0];
    await service.start();

    // 2. Recall memories — should pass the stored token via consistency
    mockClient.promises.lookupResources.mockResolvedValue([{ resourceObjectId: "main" }]);
    const nodes = [
      { uuid: "n1", name: "Test", summary: "Test entity", group_id: "main", labels: [], created_at: "2026-01-15T00:00:00Z", attributes: {} },
    ];
    setupGraphitiMock(JSON.stringify({ message: "Found 1 node", nodes, facts: [] }));

    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    await recallTool.execute("call-token-2", { query: "test" });

    // Verify lookupResources was called with consistency containing the write token
    const lookupCalls = mockClient.promises.lookupResources.mock.calls;
    const lastLookupCall = lookupCalls[lookupCalls.length - 1][0];
    expect(lastLookupCall.consistency).toEqual({
      requirement: {
        oneofKind: "atLeastAsFresh",
        atLeastAsFresh: { token: "write-token-1" },
      },
    });
  });

  test("config rejects missing spicedb token", async () => {
    const { default: plugin } = await import("./index.js");

    mockApi.pluginConfig = { spicedb: {} };
    expect(() => plugin.register(mockApi)).toThrow("spicedb.token is required");
  });

  test("service start verifies connectivity", async () => {
    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const service = registeredServices[0];
    await service.start({});

    expect(logs.some((l) => l.includes("initialized"))).toBe(true);
  });

  test("auto-capture sends batch episode with conversation text", async () => {
    mockApi.pluginConfig.autoCapture = true;
    setupGraphitiMock('{"message":"Episode queued"}');

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const agentEndHook = registeredHooks["agent_end"]?.[0];
    expect(agentEndHook).toBeDefined();

    await agentEndHook({
      success: true,
      messages: [
        { role: "user", content: "I prefer dark mode for all editors" },
        { role: "assistant", content: "Got it! I'll remember your dark mode preference." },
        { role: "user", content: "Also, my email is mark@example.com" },
      ],
    }, { sessionKey: "sess-cap-1" });

    // Verify add_memory was called (tool name changed from add_episode)
    const fetchCalls = mockFetch.mock.calls;
    const addMemoryCall = fetchCalls.find((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCall).toBeDefined();

    const body = JSON.parse(addMemoryCall![1]!.body as string);
    const episodeBody = body.params.arguments.episode_body;
    // Should contain all 3 messages as a batch
    expect(episodeBody).toContain("User: I prefer dark mode");
    expect(episodeBody).toContain("Assistant: Got it!");
    expect(episodeBody).toContain("User: Also, my email");

    // Should go to session group
    expect(body.params.arguments.group_id).toBe("session-sess-cap-1");

    // custom_extraction_instructions are prepended to episode_body
    expect(body.params.arguments.episode_body).toContain("[Extraction Instructions]");
    expect(body.params.arguments.episode_body).toContain("[End Instructions]");
    expect(body.params.arguments.custom_extraction_instructions).toBeUndefined();

    // Should log the capture
    expect(logs.some((l) => l.includes("auto-captured") && l.includes("batch episode"))).toBe(true);
  });

  test("auto-capture skips messages with injected context", async () => {
    mockApi.pluginConfig.autoCapture = true;
    setupGraphitiMock('{"message":"queued"}');

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const agentEndHook = registeredHooks["agent_end"]?.[0];

    await agentEndHook({
      success: true,
      messages: [
        { role: "user", content: "<relevant-memories>injected context here</relevant-memories> What about Mark?" },
        { role: "assistant", content: "Mark is doing great!" },
      ],
    });

    // Verify the episode body does NOT include the injected context message
    const fetchCalls = mockFetch.mock.calls;
    const addMemoryCall = fetchCalls.find((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "add_memory";
    });
    expect(addMemoryCall).toBeDefined();

    const body = JSON.parse(addMemoryCall![1]!.body as string);
    const episodeBody = body.params.arguments.episode_body;
    expect(episodeBody).not.toContain("<relevant-memories>");
    // Should only contain the assistant message
    expect(episodeBody).toContain("Assistant: Mark is doing great!");
  });

  // ==========================================================================
  // CLI: cleanup command
  // ==========================================================================

  /**
   * Create a mock Commander program that captures subcommand action handlers.
   * The plugin calls: program.command("graphiti-mem").description(...) then
   * mem.command("cleanup").option(...).action(handler).
   */
  function createMockProgram() {
    // oxlint-disable-next-line typescript/no-explicit-any
    const actions: Record<string, any> = {};

    // oxlint-disable-next-line typescript/no-explicit-any
    function makeChainable(commandName?: string): any {
      // oxlint-disable-next-line typescript/no-explicit-any
      const self: Record<string, any> = {};
      self.description = () => self;
      self.argument = () => self;
      self.option = () => self;
      self.command = (name: string) => makeChainable(name);
      // oxlint-disable-next-line typescript/no-explicit-any
      self.action = (fn: any) => {
        if (commandName) actions[commandName] = fn;
        return self;
      };
      return self;
    }

    return { program: makeChainable(), actions };
  }

  test("cleanup command reports no episodes when group is empty", async () => {
    // Mock Graphiti to return empty episodes list
    setupGraphitiMock(JSON.stringify({ episodes: [] }));

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const { program, actions } = createMockProgram();
    registeredClis[0].registrar({ program });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions["cleanup"]({ group: "main", last: "100", delete: false, dryRun: false });

    expect(consoleSpy.mock.calls.some((c) => c[0].includes("No episodes found"))).toBe(true);
    consoleSpy.mockRestore();
  });

  test("cleanup command identifies orphaned episodes", async () => {
    // Mock Graphiti to return episodes, some with and some without SpiceDB relationships
    const episodes = [
      { uuid: "ep-1", name: "ep1", content: "content1", source_description: "test", group_id: "main", created_at: "2026-02-09T00:00:00Z" },
      { uuid: "ep-2", name: "ep2", content: "content2", source_description: "test", group_id: "main", created_at: "2026-02-09T00:00:00Z" },
      { uuid: "ep-3", name: "ep3", content: "content3", source_description: "test", group_id: "main", created_at: "2026-02-10T00:00:00Z" },
    ];
    setupGraphitiMock(JSON.stringify({ episodes }));

    // Mock SpiceDB readRelationships to only return ep-1 (ep-2 and ep-3 are orphans)
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.readRelationships.mockResolvedValue([
      {
        relationship: {
          resource: { objectType: "memory_fragment", objectId: "ep-1" },
          relation: "source_group",
          subject: { object: { objectType: "group", objectId: "main" } },
        },
      },
    ]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const { program, actions } = createMockProgram();
    registeredClis[0].registrar({ program });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions["cleanup"]({ group: "main", last: "100", delete: false, dryRun: false });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Found 2 orphaned episodes");
    expect(output).toContain("ep-2");
    expect(output).toContain("ep-3");
    expect(output).not.toContain("ep-1");
    expect(output).toContain("Run with --delete");
    consoleSpy.mockRestore();
  });

  test("cleanup command reports no orphans when all episodes have relationships", async () => {
    const episodes = [
      { uuid: "ep-1", name: "ep1", content: "c", source_description: "t", group_id: "main", created_at: "2026-02-09T00:00:00Z" },
    ];
    setupGraphitiMock(JSON.stringify({ episodes }));

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.readRelationships.mockResolvedValue([
      {
        relationship: {
          resource: { objectType: "memory_fragment", objectId: "ep-1" },
          relation: "source_group",
          subject: { object: { objectType: "group", objectId: "main" } },
        },
      },
    ]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const { program, actions } = createMockProgram();
    registeredClis[0].registrar({ program });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions["cleanup"]({ group: "main", last: "100", delete: false, dryRun: false });

    expect(consoleSpy.mock.calls.some((c) => c[0].includes("No orphans found"))).toBe(true);
    consoleSpy.mockRestore();
  });

  test("cleanup command deletes orphans with --delete flag", async () => {
    const episodes = [
      { uuid: "ep-orphan-1", name: "ep1", content: "c", source_description: "t", group_id: "main", created_at: "2026-02-09T00:00:00Z" },
      { uuid: "ep-orphan-2", name: "ep2", content: "c", source_description: "t", group_id: "main", created_at: "2026-02-10T00:00:00Z" },
    ];
    setupGraphitiMock(JSON.stringify({ episodes }));

    // No SpiceDB relationships — both are orphans
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.readRelationships.mockResolvedValue([]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const { program, actions } = createMockProgram();
    registeredClis[0].registrar({ program });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions["cleanup"]({ group: "main", last: "100", delete: true, dryRun: false });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Found 2 orphaned episodes");
    expect(output).toContain("Deleted 2 orphaned episodes");

    // Verify delete_episode was called for each orphan
    const deleteCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_episode";
    });
    expect(deleteCalls).toHaveLength(2);
    consoleSpy.mockRestore();
  });

  test("cleanup command with --dry-run does not delete", async () => {
    const episodes = [
      { uuid: "ep-dry", name: "ep1", content: "c", source_description: "t", group_id: "main", created_at: "2026-02-09T00:00:00Z" },
    ];
    setupGraphitiMock(JSON.stringify({ episodes }));

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.readRelationships.mockResolvedValue([]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const { program, actions } = createMockProgram();
    registeredClis[0].registrar({ program });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await actions["cleanup"]({ group: "main", last: "10", delete: true, dryRun: true });

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Found 1 orphaned episodes");
    expect(output).toContain("Run with --delete");
    expect(output).not.toContain("Deleted");

    // Verify delete_episode was NOT called
    const deleteCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_episode";
    });
    expect(deleteCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  // ==========================================================================
  // memory_forget: fact deletion
  // ==========================================================================

  test("memory_forget with fact_id fetches fact, checks group write, deletes edge", async () => {
    const factData = {
      uuid: "fact-abc",
      fact: "Mark works at Acme",
      source_node_name: "Mark",
      target_node_name: "Acme",
      group_id: "main",
      created_at: "2026-01-15",
    };

    // Custom mock: get_entity_edge returns fact data, delete_entity_edge returns ok
    mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        return Promise.resolve(new Response("OK", { status: 200 }));
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.method === "initialize") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { capabilities: { tools: {} }, serverInfo: { name: "Graphiti", version: "1.0" }, protocolVersion: "2024-11-05" },
        }));
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      // get_entity_edge returns the fact as a flat object
      if (body.params?.name === "get_entity_edge") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(factData) }], isError: false },
        }));
      }
      // delete_entity_edge returns ok
      return Promise.resolve(makeSseResponse({
        jsonrpc: "2.0", id: body.id || 1,
        result: { content: [{ type: "text", text: '{"message":"deleted"}' }], isError: false },
      }));
    });

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-fact-del", { fact_id: "fact-abc" });

    expect(result.details.action).toBe("deleted");
    expect(result.details.factId).toBe("fact-abc");

    // Verify get_entity_edge was called
    const getEdgeCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "get_entity_edge";
    });
    expect(getEdgeCalls).toHaveLength(1);

    // Verify delete_entity_edge was called
    const deleteEdgeCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_entity_edge";
    });
    expect(deleteEdgeCalls).toHaveLength(1);
  });

  test("memory_forget with fact_id denies when no write permission on group", async () => {
    const factData = {
      uuid: "fact-denied",
      fact: "Secret fact",
      group_id: "restricted-group",
      created_at: "2026-01-15",
    };

    mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        return Promise.resolve(new Response("OK", { status: 200 }));
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.method === "initialize") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { capabilities: { tools: {} }, serverInfo: { name: "Graphiti", version: "1.0" }, protocolVersion: "2024-11-05" },
        }));
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (body.params?.name === "get_entity_edge") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(factData) }], isError: false },
        }));
      }
      return Promise.resolve(makeSseResponse({
        jsonrpc: "2.0", id: body.id || 1,
        result: { content: [{ type: "text", text: '{"message":"ok"}' }], isError: false },
      }));
    });

    // Deny contribute permission on the fact's group
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "contribute") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 });
    });

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-fact-denied", { fact_id: "fact-denied" });

    expect(result.details.action).toBe("denied");
    expect(result.details.factId).toBe("fact-denied");

    // Verify delete_entity_edge was NOT called
    const deleteEdgeCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_entity_edge";
    });
    expect(deleteEdgeCalls).toHaveLength(0);
  });

  test("memory_forget with neither episode_id nor fact_id returns error", async () => {
    setupGraphitiMock();

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-no-id", {});

    expect(result.details.action).toBe("error");
    expect(result.content[0].text).toContain("Either episode_id or fact_id must be provided");
  });

  // ==========================================================================
  // memory_forget: episode deletion fallback authorization (#29)
  // ==========================================================================

  test("memory_forget falls back to group-level auth when no SpiceDB relationships exist", async () => {
    // Scenario: deferred SpiceDB write failed → fragment has no relationships.
    // Fallback searches authorized groups for the episode and uses canWriteToGroup.
    const episodes = [
      { uuid: "ep-orphan", name: "mem_1", content: "test", source_description: "conv", group_id: "main", created_at: "2026-02-10T00:00:00Z" },
    ];

    // Custom fetch mock: get_episodes returns the orphaned episode, delete_episode succeeds
    mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        return Promise.resolve(new Response("OK", { status: 200 }));
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.method === "initialize") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { capabilities: { tools: {} }, serverInfo: { name: "Graphiti", version: "1.0" }, protocolVersion: "2024-11-05" },
        }));
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (body.params?.name === "get_episodes") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify({ episodes }) }], isError: false },
        }));
      }
      // delete_episode and any other tool
      return Promise.resolve(makeSseResponse({
        jsonrpc: "2.0", id: body.id || 1,
        result: { content: [{ type: "text", text: '{"message":"deleted"}' }], isError: false },
      }));
    });

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();

    // Deny fragment-level delete, allow group-level contribute
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "delete") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 }); // HAS_PERMISSION (contribute)
    });
    // No SpiceDB relationships for this fragment (deferred write failed)
    mockClient.promises.readRelationships.mockResolvedValue([]);
    // Subject is authorized for "main" group
    mockClient.promises.lookupResources.mockResolvedValue([{ resourceObjectId: "main" }]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-fallback", { episode_id: "ep-orphan" });

    expect(result.details.action).toBe("deleted");
    expect(result.details.episodeId).toBe("ep-orphan");

    // Verify delete_episode was called
    const deleteCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_episode";
    });
    expect(deleteCalls).toHaveLength(1);
  });

  test("memory_forget denies when shared_by exists for a different subject", async () => {
    // Scenario: SpiceDB has shared_by for a different subject — genuine denial, no fallback.
    setupGraphitiMock('{"message":"deleted"}');

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();

    // Deny fragment-level delete
    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "delete") {
        return Promise.resolve({ permissionship: 1 }); // NO_PERMISSION
      }
      return Promise.resolve({ permissionship: 2 });
    });
    // SpiceDB HAS relationships — shared_by exists (for a different subject)
    mockClient.promises.readRelationships.mockResolvedValue([
      {
        relationship: {
          resource: { objectType: "memory_fragment", objectId: "ep-other" },
          relation: "shared_by",
          subject: { object: { objectType: "agent", objectId: "other-agent" } },
        },
      },
    ]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-genuine-deny", { episode_id: "ep-other" });

    expect(result.details.action).toBe("denied");
    expect(result.content[0].text).toContain("Permission denied");

    // Verify delete_episode was NOT called
    const deleteCalls = mockFetch.mock.calls.filter((call) => {
      if (!call[1]?.body) return false;
      const body = JSON.parse(call[1].body as string);
      return body.params?.name === "delete_episode";
    });
    expect(deleteCalls).toHaveLength(0);
  });

  test("memory_forget denies when no SpiceDB rels and episode not in any authorized group", async () => {
    // Scenario: orphaned fragment + episode not found in authorized groups → denied.
    const episodes = [
      { uuid: "ep-different", name: "other", content: "c", source_description: "t", group_id: "main", created_at: "2026-02-10T00:00:00Z" },
    ];

    mockFetch.mockImplementation((url: string | URL, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/health")) {
        return Promise.resolve(new Response("OK", { status: 200 }));
      }
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.method === "initialize") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { capabilities: { tools: {} }, serverInfo: { name: "Graphiti", version: "1.0" }, protocolVersion: "2024-11-05" },
        }));
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      if (body.params?.name === "get_episodes") {
        return Promise.resolve(makeSseResponse({
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify({ episodes }) }], isError: false },
        }));
      }
      return Promise.resolve(makeSseResponse({
        jsonrpc: "2.0", id: body.id || 1,
        result: { content: [{ type: "text", text: '{"message":"ok"}' }], isError: false },
      }));
    });

    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();

    mockClient.promises.checkPermission.mockImplementation((req: Record<string, unknown>) => {
      if (req.permission === "delete") {
        return Promise.resolve({ permissionship: 1 });
      }
      return Promise.resolve({ permissionship: 2 });
    });
    mockClient.promises.readRelationships.mockResolvedValue([]);
    mockClient.promises.lookupResources.mockResolvedValue([{ resourceObjectId: "main" }]);

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const result = await forgetTool.execute("call-not-found", { episode_id: "ep-nonexistent" });

    expect(result.details.action).toBe("denied");
    expect(result.content[0].text).toContain("Permission denied");
  });

  test("auto-recall performs dual search with session and long-term groups", async () => {
    mockApi.pluginConfig.autoRecall = true;

    // Mock Graphiti search responses — needs both nodes and facts keys
    const nodes = [
      { uuid: "n1", name: "Mark", summary: "Mark is a developer", group_id: "main", labels: [], created_at: "2026-01-15T00:00:00Z", attributes: {} },
    ];
    setupGraphitiMock(JSON.stringify({ message: "Found 1 node", nodes, facts: [] }));

    const { default: plugin } = await import("./index.js");
    plugin.register(mockApi);

    const beforeHook = registeredHooks["before_agent_start"]?.[0];
    expect(beforeHook).toBeDefined();

    const result = await beforeHook({
      prompt: "What does Mark do for work?",
    }, { sessionKey: "sess-recall-1" });

    // Should return prepended context
    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("</relevant-memories>");

    // Should log injection with long-term/session breakdown
    expect(logs.some((l) => l.includes("injecting") && l.includes("long-term"))).toBe(true);
  });
});
