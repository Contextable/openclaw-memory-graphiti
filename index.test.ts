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
    writeRelationships: vi.fn().mockResolvedValue({}),
    checkPermission: vi.fn().mockResolvedValue({
      permissionship: 2, // HAS_PERMISSION
    }),
    lookupResources: vi.fn().mockResolvedValue([
      { resourceObjectId: "main" },
    ]),
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
      CheckPermissionRequest: { create: vi.fn((v: unknown) => v) },
      CheckPermissionResponse_Permissionship: { HAS_PERMISSION: 2 },
      LookupResourcesRequest: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate_Operation: { TOUCH: 1, DELETE: 2 },
      Relationship: { create: vi.fn((v: unknown) => v) },
      ObjectReference: { create: vi.fn((v: unknown) => v) },
      SubjectReference: { create: vi.fn((v: unknown) => v) },
      Consistency: { create: vi.fn((v: unknown) => v) },
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
      await beforeHook({ prompt: "hello world test prompt", ctx: { sessionKey: "sess-123" } });
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
      await beforeHook({ prompt: "test prompt for session", ctx: { sessionKey: "sess-write" } });
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
      await beforeHook({ prompt: "test", ctx: { sessionKey: "my-session" } });
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
    });

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
      ctx: { sessionKey: "sess-cap-1" },
    });

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
      ctx: { sessionKey: "sess-recall-1" },
    });

    // Should return prepended context
    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("</relevant-memories>");

    // Should log injection with long-term/session breakdown
    expect(logs.some((l) => l.includes("injecting") && l.includes("long-term"))).toBe(true);
  });
});
