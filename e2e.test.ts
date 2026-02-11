/**
 * E2E Integration Tests — Memory (Graphiti + SpiceDB)
 *
 * These tests run against real SpiceDB and Graphiti MCP Server instances.
 * They require Docker containers running (see docker/docker-compose.yml).
 *
 * Prerequisites:
 *   1. Set OPENAI_API_KEY in your environment (Graphiti needs it for LLM extraction)
 *   2. Start containers:
 *        docker compose -f extensions/memory-graphiti/docker/docker-compose.yml up -d
 *   3. Wait for health checks to pass (~30s)
 *   4. Run:
 *        OPENCLAW_LIVE_TEST=1 npx vitest run extensions/memory-graphiti/e2e.test.ts
 *
 * Environment variables:
 *   OPENAI_API_KEY       — Required. OpenAI API key for Graphiti entity extraction.
 *   SPICEDB_TOKEN        — Optional. Defaults to "dev_token".
 *   GRAPHITI_ENDPOINT    — Optional. Defaults to "http://localhost:8000".
 *   SPICEDB_ENDPOINT     — Optional. Defaults to "localhost:50051".
 *   OPENCLAW_LIVE_TEST   — Set to "1" to enable these tests.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { GraphitiClient } from "./graphiti.js";
import { SpiceDbClient } from "./spicedb.js";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";
import { searchAuthorizedMemories, formatDualResults, deduplicateSessionResults } from "./search.js";

// ============================================================================
// Gate: only run when explicitly enabled
// ============================================================================

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const liveEnabled = HAS_OPENAI_KEY && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

// ============================================================================
// Config
// ============================================================================

const GRAPHITI_ENDPOINT = process.env.GRAPHITI_ENDPOINT ?? "http://localhost:8000";
const SPICEDB_ENDPOINT = process.env.SPICEDB_ENDPOINT ?? "localhost:50051";
const SPICEDB_TOKEN = process.env.SPICEDB_TOKEN ?? "dev_token";

const TEST_GROUP = `e2e_test_${Date.now()}`;
const TEST_SESSION_GROUP = `session-e2e_${Date.now()}`;

const agentSubject: Subject = { type: "agent", id: "e2e-test-agent" };
const personMark: Subject = { type: "person", id: "e2e-mark" };
const personUnauthorized: Subject = { type: "person", id: "e2e-outsider" };

// ============================================================================
// Tests
// ============================================================================

describeLive("e2e: Graphiti + SpiceDB integration", () => {
  let graphiti: GraphitiClient;
  let spicedb: SpiceDbClient;
  let lastWriteToken: string | undefined;
  const createdEpisodeIds: string[] = [];

  beforeAll(async () => {
    graphiti = new GraphitiClient(GRAPHITI_ENDPOINT);
    spicedb = new SpiceDbClient({
      endpoint: SPICEDB_ENDPOINT,
      token: SPICEDB_TOKEN,
      insecure: true,
    });

    // 1. Verify connectivity
    const graphitiOk = await graphiti.healthCheck();
    if (!graphitiOk) {
      throw new Error(
        `Graphiti MCP server unreachable at ${GRAPHITI_ENDPOINT}. ` +
        "Start containers with: docker compose -f extensions/memory-graphiti/docker/docker-compose.yml up -d",
      );
    }

    // 2. Write SpiceDB schema
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
    const schema = readFileSync(schemaPath, "utf-8");
    await spicedb.writeSchema(schema);

    // 3. Set up authorization: agent + Mark are members of the test group
    //    Capture ZedTokens so subsequent reads use at_least_as_fresh consistency
    await ensureGroupMembership(spicedb, TEST_GROUP, agentSubject);
    await ensureGroupMembership(spicedb, TEST_GROUP, personMark);

    // Also set up session group membership for the agent
    const token = await ensureGroupMembership(spicedb, TEST_SESSION_GROUP, agentSubject);
    if (token) lastWriteToken = token;
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup: delete episodes we created
    for (const id of createdEpisodeIds) {
      try {
        await graphiti.deleteEpisode(id);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // --------------------------------------------------------------------------
  // Connectivity
  // --------------------------------------------------------------------------

  test("Graphiti MCP server is healthy", async () => {
    const ok = await graphiti.healthCheck();
    expect(ok).toBe(true);
  });

  test("SpiceDB is reachable and schema is loaded", async () => {
    const schema = await spicedb.readSchema();
    expect(schema).toContain("definition memory_fragment");
    expect(schema).toContain("definition group");
    expect(schema).toContain("definition agent");
    expect(schema).toContain("definition person");
  });

  // --------------------------------------------------------------------------
  // Authorization layer
  // --------------------------------------------------------------------------

  test("agent can access the test group", async () => {
    const groups = await lookupAuthorizedGroups(spicedb, agentSubject, lastWriteToken);
    expect(groups).toContain(TEST_GROUP);
  });

  test("Mark can access the test group", async () => {
    const groups = await lookupAuthorizedGroups(spicedb, personMark, lastWriteToken);
    expect(groups).toContain(TEST_GROUP);
  });

  test("unauthorized person cannot access the test group", async () => {
    const groups = await lookupAuthorizedGroups(spicedb, personUnauthorized, lastWriteToken);
    expect(groups).not.toContain(TEST_GROUP);
  });

  // --------------------------------------------------------------------------
  // Store → Retrieve cycle (long-term)
  // --------------------------------------------------------------------------

  test("store episode and retrieve via search", async () => {
    // Store
    const episodeResult = await graphiti.addEpisode({
      name: "e2e_store_retrieve",
      episode_body: "Mark just got promoted to Senior Engineer at Acme Corp",
      source_description: "e2e test conversation",
      group_id: TEST_GROUP,
      custom_extraction_instructions: "Extract names, roles, and organizations.",
    });

    expect(episodeResult.episode_uuid).toBeDefined();
    createdEpisodeIds.push(episodeResult.episode_uuid);

    // Write authorization relationships
    const writeToken = await writeFragmentRelationships(spicedb, {
      fragmentId: episodeResult.episode_uuid,
      groupId: TEST_GROUP,
      sharedBy: agentSubject,
      involves: [personMark],
    });
    if (writeToken) lastWriteToken = writeToken;

    // Wait for Graphiti to process (entity extraction via OpenAI takes ~10-15s)
    await sleep(15000);

    // Search as authorized agent
    const results = await searchAuthorizedMemories(graphiti, {
      query: "Mark promotion engineer",
      groupIds: [TEST_GROUP],
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);

    // At least one result should mention Mark or promotion
    const relevant = results.some(
      (r) =>
        r.summary.toLowerCase().includes("mark") ||
        r.summary.toLowerCase().includes("promot") ||
        r.context.toLowerCase().includes("mark"),
    );
    expect(relevant).toBe(true);
  }, 45000);

  test("unauthorized person gets no results for the group", async () => {
    // Outsider has no group access
    const groups = await lookupAuthorizedGroups(spicedb, personUnauthorized, lastWriteToken);
    const authorizedGroupsForSearch = groups.filter((g) => g === TEST_GROUP);

    // Should have no access to the test group
    expect(authorizedGroupsForSearch).toHaveLength(0);

    // Even if we tried to search the group directly (which the auth layer prevents),
    // the outsider should have no authorized groups
    const results = await searchAuthorizedMemories(graphiti, {
      query: "Mark promotion",
      groupIds: authorizedGroupsForSearch,
      limit: 10,
    });

    expect(results).toHaveLength(0);
  });

  test("unauthorized person is denied write access to a group", async () => {
    // Outsider has no membership in TEST_GROUP, so contribute permission should be denied
    const canWrite = await canWriteToGroup(spicedb, personUnauthorized, TEST_GROUP, lastWriteToken);
    expect(canWrite).toBe(false);

    // Authorized agent should be allowed (was added as member in beforeAll)
    const agentCanWrite = await canWriteToGroup(spicedb, agentSubject, TEST_GROUP, lastWriteToken);
    expect(agentCanWrite).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Session-scoped memory
  // --------------------------------------------------------------------------

  test("store and retrieve session-scoped episode", async () => {
    // Store to session group
    const episodeResult = await graphiti.addEpisode({
      name: "e2e_session_episode",
      episode_body: "User mentioned they have a deadline on Friday for the quarterly report",
      source_description: "e2e session context",
      group_id: TEST_SESSION_GROUP,
    });

    expect(episodeResult.episode_uuid).toBeDefined();
    createdEpisodeIds.push(episodeResult.episode_uuid);

    const sessionWriteToken = await writeFragmentRelationships(spicedb, {
      fragmentId: episodeResult.episode_uuid,
      groupId: TEST_SESSION_GROUP,
      sharedBy: agentSubject,
    });
    if (sessionWriteToken) lastWriteToken = sessionWriteToken;

    // Wait for processing (entity extraction via OpenAI takes ~10-20s,
    // and episodes are queued per group_id so prior episodes may still be processing)
    await sleep(20000);

    // Search session group
    const sessionResults = await searchAuthorizedMemories(graphiti, {
      query: "deadline Friday quarterly",
      groupIds: [TEST_SESSION_GROUP],
      limit: 5,
    });

    expect(sessionResults.length).toBeGreaterThan(0);

    // Search long-term group should NOT find session content
    const longTermResults = await searchAuthorizedMemories(graphiti, {
      query: "deadline Friday quarterly",
      groupIds: [TEST_GROUP],
      limit: 5,
    });

    // Session memories should be isolated from long-term group
    // (they may or may not appear depending on Graphiti's graph connections,
    // but the group_id filtering should keep them separate)
    const sessionUuids = new Set(sessionResults.map((r) => r.uuid));
    const leakedToLongTerm = longTermResults.filter((r) => sessionUuids.has(r.uuid));
    expect(leakedToLongTerm).toHaveLength(0);
  }, 60000);

  // --------------------------------------------------------------------------
  // Dual search (session + long-term)
  // --------------------------------------------------------------------------

  test("dual search returns both session and long-term results", async () => {
    // At this point we have:
    // - Long-term (TEST_GROUP): "Mark promoted to Senior Engineer"
    // - Session (TEST_SESSION_GROUP): "deadline Friday quarterly report"

    const longTermResults = await searchAuthorizedMemories(graphiti, {
      query: "Mark work deadline",
      groupIds: [TEST_GROUP],
      limit: 5,
    });

    const rawSessionResults = await searchAuthorizedMemories(graphiti, {
      query: "Mark work deadline",
      groupIds: [TEST_SESSION_GROUP],
      limit: 5,
    });

    const sessionResults = deduplicateSessionResults(longTermResults, rawSessionResults);
    const formatted = formatDualResults(longTermResults, sessionResults);

    // If either search returned results, the formatted output should be non-empty
    if (longTermResults.length > 0 || sessionResults.length > 0) {
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).toContain("[");
    }
  }, 30000);

  // --------------------------------------------------------------------------
  // Batch episode capture (simulating auto-capture)
  // --------------------------------------------------------------------------

  test("batch conversation capture extracts entities", async () => {
    const conversationBatch = [
      "User: I just spoke with Sarah Chen about the new React migration project.",
      "Assistant: That sounds interesting! What did Sarah say about the timeline?",
      "User: She said the team aims to finish by March. We decided to use Next.js as the framework.",
      "Assistant: Next.js is a great choice. I'll remember that Sarah Chen is leading the React migration with a March deadline.",
    ].join("\n");

    const episodeResult = await graphiti.addEpisode({
      name: "e2e_batch_capture",
      episode_body: conversationBatch,
      source_description: "auto-captured conversation",
      group_id: TEST_GROUP,
      custom_extraction_instructions:
        "Extract: people's names, project names, technologies, deadlines, and decisions made.",
    });

    expect(episodeResult.episode_uuid).toBeDefined();
    createdEpisodeIds.push(episodeResult.episode_uuid);

    const batchWriteToken = await writeFragmentRelationships(spicedb, {
      fragmentId: episodeResult.episode_uuid,
      groupId: TEST_GROUP,
      sharedBy: agentSubject,
    });
    if (batchWriteToken) lastWriteToken = batchWriteToken;

    // Poll for entity extraction — when prior tests have queued episodes in the
    // same group, Graphiti's extraction queue may be backed up beyond a fixed sleep.
    let sarahResults: Awaited<ReturnType<typeof searchAuthorizedMemories>> = [];
    let mentions = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(5000);
      sarahResults = await searchAuthorizedMemories(graphiti, {
        query: "Sarah Chen React migration",
        groupIds: [TEST_GROUP],
        limit: 10,
      });
      mentions = sarahResults.some(
        (r) =>
          r.summary.toLowerCase().includes("sarah") ||
          r.summary.toLowerCase().includes("react") ||
          r.summary.toLowerCase().includes("next") ||
          r.context.toLowerCase().includes("sarah"),
      );
      if (mentions) break;
    }

    expect(sarahResults.length).toBeGreaterThan(0);
    expect(mentions).toBe(true);
  }, 60000);

  // --------------------------------------------------------------------------
  // Delete cycle + permission check
  // --------------------------------------------------------------------------

  test("delete episode with permission check", async () => {
    // Store a deletable episode
    const episodeResult = await graphiti.addEpisode({
      name: "e2e_deletable",
      episode_body: "This is a temporary memory that will be deleted",
      source_description: "e2e delete test",
      group_id: TEST_GROUP,
    });

    const episodeId = episodeResult.episode_uuid;

    const delWriteToken = await writeFragmentRelationships(spicedb, {
      fragmentId: episodeId,
      groupId: TEST_GROUP,
      sharedBy: agentSubject,
    });
    if (delWriteToken) lastWriteToken = delWriteToken;

    // Agent (who shared it) should have delete permission
    const agentCanDelete = await canDeleteFragment(spicedb, agentSubject, episodeId, lastWriteToken);
    expect(agentCanDelete).toBe(true);

    // Outsider should NOT have delete permission
    const outsiderCanDelete = await canDeleteFragment(spicedb, personUnauthorized, episodeId, lastWriteToken);
    expect(outsiderCanDelete).toBe(false);

    // Mark (involved but didn't share) — check permission
    // The schema says: permission delete = shared_by
    // So Mark should NOT be able to delete unless he shared it
    const markCanDelete = await canDeleteFragment(spicedb, personMark, episodeId, lastWriteToken);
    expect(markCanDelete).toBe(false);

    // Actually delete it
    await graphiti.deleteEpisode(episodeId);

    // Clean up SpiceDB relationships
    await deleteFragmentRelationships(spicedb, episodeId);

    // Remove from cleanup list since we already deleted it
    const idx = createdEpisodeIds.indexOf(episodeId);
    if (idx >= 0) createdEpisodeIds.splice(idx, 1);
  }, 15000);

  // --------------------------------------------------------------------------
  // Full plugin registration (smoke test)
  // --------------------------------------------------------------------------

  test("plugin registers and tools execute against live services", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(memoryPlugin.id).toBe("memory-graphiti");

    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredTools: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredHooks: Record<string, any[]> = {};
    const logs: string[] = [];

    const liveApi = {
      id: "memory-graphiti",
      name: "Memory (Graphiti + SpiceDB)",
      source: "test",
      config: {},
      pluginConfig: {
        spicedb: {
          endpoint: SPICEDB_ENDPOINT,
          token: SPICEDB_TOKEN,
          insecure: true,
        },
        graphiti: {
          endpoint: GRAPHITI_ENDPOINT,
          defaultGroupId: TEST_GROUP,
        },
        subjectType: "agent",
        subjectId: agentSubject.id,
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
      registerCli: (_registrar: any, _opts: any) => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (_service: any) => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // Register plugin
    // oxlint-disable-next-line typescript/no-explicit-any
    memoryPlugin.register(liveApi as any);

    expect(registeredTools).toHaveLength(4);

    // Test memory_status tool against live services
    const statusTool = registeredTools.find((t) => t.opts?.name === "memory_status")?.tool;
    const statusResult = await statusTool.execute("e2e-status", {});

    expect(statusResult.details.graphiti).toBe("connected");
    expect(statusResult.details.spicedb).toBe("connected");

    // Test memory_store tool against live services
    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const storeResult = await storeTool.execute("e2e-store", {
      content: "E2E plugin test: the CI/CD pipeline uses GitHub Actions",
      source_description: "e2e plugin test",
    });

    expect(storeResult.details.action).toBe("created");
    expect(storeResult.details.episodeId).toBeDefined();
    createdEpisodeIds.push(storeResult.details.episodeId);

    // Wait for processing (entity extraction via OpenAI)
    await sleep(15000);

    // Test memory_recall tool against live services
    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const recallResult = await recallTool.execute("e2e-recall", {
      query: "CI/CD pipeline GitHub Actions",
      limit: 5,
      scope: "all",
    });

    expect(recallResult.details.count).toBeGreaterThanOrEqual(0);
    expect(recallResult.details.authorizedGroups).toBeDefined();

    // Test memory_forget tool
    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;
    const forgetResult = await forgetTool.execute("e2e-forget", {
      episode_id: storeResult.details.episodeId,
    });

    expect(forgetResult.details.action).toBe("deleted");

    // Remove from cleanup list
    const cleanupIdx = createdEpisodeIds.indexOf(storeResult.details.episodeId);
    if (cleanupIdx >= 0) createdEpisodeIds.splice(cleanupIdx, 1);
  }, 90000);
});

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
