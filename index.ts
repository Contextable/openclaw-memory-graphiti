/**
 * OpenClaw Memory (Graphiti + SpiceDB) Plugin
 *
 * Two-layer memory architecture:
 * - SpiceDB: authorization gateway (who can see what)
 * - Graphiti: knowledge graph storage (entities, facts, episodes)
 *
 * SpiceDB determines which memories a subject can access.
 * Graphiti stores the actual conversational memory and entity relationships.
 * Authorization is enforced at the data layer, not in prompts.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { graphitiMemoryConfigSchema } from "./config.js";
import { GraphitiClient } from "./graphiti.js";
import { SpiceDbClient } from "./spicedb.js";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  canWriteToGroup,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";
import {
  searchAuthorizedMemories,
  formatDualResults,
  deduplicateSessionResults,
} from "./search.js";
import { registerCommands } from "./cli.js";

// ============================================================================
// Session helpers
// ============================================================================

function sessionGroupId(sessionId: string): string {
  // Graphiti group_ids only allow alphanumeric, dashes, underscores.
  // OpenClaw sessionKey can contain colons (e.g. "agent:main:main") — replace invalid chars.
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `session-${sanitized}`;
}

function isSessionGroup(groupId: string): boolean {
  return groupId.startsWith("session-");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryGraphitiPlugin = {
  id: "openclaw-memory-graphiti",
  name: "Memory (Graphiti + SpiceDB)",
  description: "Two-layer memory: SpiceDB authorization + Graphiti knowledge graph",
  kind: "memory" as const,
  configSchema: graphitiMemoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = graphitiMemoryConfigSchema.parse(api.pluginConfig);

    const graphiti = new GraphitiClient(cfg.graphiti.endpoint);
    graphiti.uuidPollIntervalMs = cfg.graphiti.uuidPollIntervalMs;
    graphiti.uuidPollMaxAttempts = cfg.graphiti.uuidPollMaxAttempts;
    const spicedb = new SpiceDbClient(cfg.spicedb);

    const currentSubject: Subject = {
      type: cfg.subjectType,
      id: cfg.subjectId,
    };

    // Track current session ID — updated from hook event context
    let currentSessionId: string | undefined;

    // Track most recent ZedToken from SpiceDB writes for causal consistency.
    // Reads use at_least_as_fresh(token) after own writes, minimize_latency otherwise.
    let lastWriteToken: string | undefined;

    api.logger.info(
      `openclaw-memory-graphiti: registered (graphiti: ${cfg.graphiti.endpoint}, spicedb: ${cfg.spicedb.endpoint})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through memories using the knowledge graph. Returns entities and facts the current user is authorized to see. Supports session, long-term, or combined scope.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          scope: Type.Optional(
            Type.Union(
              [Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")],
              { description: "Memory scope: 'session' (current session only), 'long-term' (persistent), or 'all' (both). Default: 'all'" },
            ),
          ),
          entity_types: Type.Optional(
            Type.Array(Type.String(), {
              description: "Filter by entity type (e.g., 'Preference', 'Organization', 'Procedure')",
            }),
          ),
          center_node_uuid: Type.Optional(
            Type.String({
              description: "UUID of an entity node to center the fact search around",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10, scope = "all", entity_types, center_node_uuid } = params as {
            query: string;
            limit?: number;
            scope?: "session" | "long-term" | "all";
            entity_types?: string[];
            center_node_uuid?: string;
          };

          // 1. Get authorized groups for current subject
          const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject, lastWriteToken);

          if (authorizedGroups.length === 0) {
            return {
              content: [{ type: "text", text: "No accessible memory groups found." }],
              details: { count: 0, authorizedGroups: [] },
            };
          }

          // 2. Filter groups by scope
          let longTermGroups: string[];
          let sessionGroups: string[];

          if (scope === "session") {
            longTermGroups = [];
            sessionGroups = authorizedGroups.filter(isSessionGroup);
            // Also include current session if not in authorized groups
            if (currentSessionId) {
              const sg = sessionGroupId(currentSessionId);
              if (!sessionGroups.includes(sg)) {
                sessionGroups.push(sg);
              }
            }
          } else if (scope === "long-term") {
            longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
            sessionGroups = [];
          } else {
            // "all"
            longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
            sessionGroups = authorizedGroups.filter(isSessionGroup);
            if (currentSessionId) {
              const sg = sessionGroupId(currentSessionId);
              if (!sessionGroups.includes(sg)) {
                sessionGroups.push(sg);
              }
            }
          }

          // 3. Parallel search across groups
          const searchOpts = { entityTypes: entity_types, centerNodeUuid: center_node_uuid };
          const [longTermResults, rawSessionResults] = await Promise.all([
            longTermGroups.length > 0
              ? searchAuthorizedMemories(graphiti, { query, groupIds: longTermGroups, limit, ...searchOpts })
              : Promise.resolve([]),
            sessionGroups.length > 0
              ? searchAuthorizedMemories(graphiti, { query, groupIds: sessionGroups, limit, ...searchOpts })
              : Promise.resolve([]),
          ]);

          // 4. Deduplicate session results against long-term
          const sessionResults = deduplicateSessionResults(longTermResults, rawSessionResults);

          const totalCount = longTermResults.length + sessionResults.length;
          if (totalCount === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, authorizedGroups },
            };
          }

          // 5. Format results with section separation
          const text = formatDualResults(longTermResults, sessionResults);
          const allResults = [...longTermResults, ...sessionResults];
          const sanitized = allResults.map((r) => ({
            type: r.type,
            uuid: r.uuid,
            group_id: r.group_id,
            summary: r.summary,
            context: r.context,
          }));

          return {
            content: [{ type: "text", text: `Found ${totalCount} memories:\n\n${text}` }],
            details: {
              count: totalCount,
              memories: sanitized,
              authorizedGroups,
              longTermCount: longTermResults.length,
              sessionCount: sessionResults.length,
            },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save information to the knowledge graph with authorization tracking. Stores episodes that are automatically broken into entities and facts. Use longTerm=false to store session-scoped memories.",
        parameters: Type.Object({
          content: Type.String({ description: "Information to remember" }),
          source_description: Type.Optional(
            Type.String({ description: "Context about the source (e.g., 'conversation with Mark')" }),
          ),
          involves: Type.Optional(
            Type.Array(Type.String(), { description: "Person/agent IDs involved in this memory" }),
          ),
          group_id: Type.Optional(
            Type.String({ description: "Target group for this memory (default: configured group)" }),
          ),
          longTerm: Type.Optional(
            Type.Boolean({ description: "Store as long-term memory (default: true). Set to false for session-scoped." }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            content,
            source_description = "conversation",
            involves = [],
            group_id,
            longTerm = true,
          } = params as {
            content: string;
            source_description?: string;
            involves?: string[];
            group_id?: string;
            longTerm?: boolean;
          };

          // Resolve target group: explicit > longTerm flag > default
          let targetGroupId: string;
          if (group_id) {
            targetGroupId = group_id;
          } else if (!longTerm && currentSessionId) {
            targetGroupId = sessionGroupId(currentSessionId);
          } else {
            targetGroupId = cfg.graphiti.defaultGroupId;
          }

          // Only auto-create membership for the agent's OWN current session.
          // Foreign session groups (belonging to other agents) require explicit
          // membership — prevents cross-agent session memory injection.
          const isOwnSession =
            isSessionGroup(targetGroupId) &&
            currentSessionId != null &&
            targetGroupId === sessionGroupId(currentSessionId);

          if (isOwnSession) {
            try {
              const token = await ensureGroupMembership(spicedb, targetGroupId, currentSubject);
              if (token) lastWriteToken = token;
            } catch {
              api.logger.warn(`openclaw-memory-graphiti: failed to ensure membership in ${targetGroupId}`);
            }
          } else {
            // All other groups (non-session AND foreign session) require write permission
            const allowed = await canWriteToGroup(spicedb, currentSubject, targetGroupId, lastWriteToken);
            if (!allowed) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Permission denied: cannot write to group "${targetGroupId}"`,
                  },
                ],
                details: { action: "denied", groupId: targetGroupId },
              };
            }
          }

          // 1. Add episode to Graphiti
          const result = await graphiti.addEpisode({
            name: `memory_${Date.now()}`,
            episode_body: content,
            source_description,
            group_id: targetGroupId,
            custom_extraction_instructions: cfg.customInstructions,
          });

          // 2. Write authorization relationships in SpiceDB (background)
          const involvedSubjects: Subject[] = involves.map((id) => ({
            type: "person" as const,
            id,
          }));

          // Chain UUID resolution → SpiceDB write in the background.
          // Graphiti processes episodes asynchronously, so the real UUID
          // isn't available immediately. Once resolved, write SpiceDB
          // relationships so authorization checks work for this fragment.
          result.resolvedUuid
            .then(async (realUuid) => {
              const writeToken = await writeFragmentRelationships(spicedb, {
                fragmentId: realUuid,
                groupId: targetGroupId,
                sharedBy: currentSubject,
                involves: involvedSubjects,
              });
              if (writeToken) lastWriteToken = writeToken;
              return realUuid;
            })
            .catch((err) => {
              api.logger.warn(
                `openclaw-memory-graphiti: deferred SpiceDB write failed for memory_store: ${err}`,
              );
            });

          return {
            content: [
              {
                type: "text",
                text: `Stored memory in group "${targetGroupId}": "${content.slice(0, 100)}..."`,
              },
            ],
            details: {
              action: "created",
              episodeId: result.episode_uuid,
              groupId: targetGroupId,
              longTerm,
              involves,
            },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description:
          "Delete a fact from the knowledge graph by ID. Use the type-prefixed IDs from memory_recall (e.g. 'fact:UUID'). Entities cannot be deleted directly — delete the facts connected to them instead.",
        parameters: Type.Object({
          id: Type.String({ description: "Fact ID to delete (e.g. 'fact:da8650cb-...')" }),
        }),
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };

          // Parse type prefix from ID (e.g. "fact:da8650cb-..." → type="fact", uuid="da8650cb-...")
          const colonIdx = id.indexOf(":");
          let idType: "fact" | "entity" | "episode";
          let uuid: string;

          if (colonIdx > 0 && colonIdx < 10) {
            const prefix = id.slice(0, colonIdx);
            uuid = id.slice(colonIdx + 1);
            if (prefix === "fact") {
              idType = "fact";
            } else if (prefix === "entity") {
              idType = "entity";
            } else {
              // Unknown prefix — treat as bare episode UUID
              idType = "episode";
              uuid = id;
            }
          } else {
            idType = "episode";
            uuid = id;
          }

          // --- Entity: not deletable via MCP server ---
          if (idType === "entity") {
            return {
              content: [{ type: "text", text: `Entities cannot be deleted directly. To remove information about an entity, delete the specific facts (edges) connected to it.` }],
              details: { action: "error", id },
            };
          }

          // --- Fact deletion ---
          if (idType === "fact") {
            let fact: Awaited<ReturnType<typeof graphiti.getEntityEdge>>;
            try {
              fact = await graphiti.getEntityEdge(uuid);
            } catch {
              return {
                content: [{ type: "text", text: `Fact ${uuid} not found.` }],
                details: { action: "not_found", id },
              };
            }

            // Graphiti allows empty-string group_ids (its default for some backends),
            // but SpiceDB ObjectIds require at least one character. Map empty to the
            // configured default so the permission check doesn't fail with INVALID_ARGUMENT.
            const effectiveGroupId = fact.group_id || cfg.graphiti.defaultGroupId;
            const allowed = await canWriteToGroup(spicedb, currentSubject, effectiveGroupId, lastWriteToken);
            if (!allowed) {
              return {
                content: [{ type: "text", text: `Permission denied: cannot delete fact in group "${effectiveGroupId}"` }],
                details: { action: "denied", id },
              };
            }

            await graphiti.deleteEntityEdge(uuid);

            return {
              content: [{ type: "text", text: `Fact forgotten.` }],
              details: { action: "deleted", id, type: "fact" },
            };
          }

          // --- Bare UUID / episode: not supported via agent tool ---
          // Episode deletion is an admin operation available via CLI (graphiti-mem cleanup).
          return {
            content: [{ type: "text", text: `Unrecognized ID format "${id}". Use IDs from memory_recall (e.g. 'fact:da8650cb-...'). Episode deletion is available via the CLI.` }],
            details: { action: "error", id },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_status",
        label: "Memory Status",
        description: "Check the health of the Graphiti and SpiceDB services.",
        parameters: Type.Object({}),
        async execute() {
          const graphitiHealthy = await graphiti.healthCheck();

          let spicedbHealthy = false;
          try {
            await spicedb.readSchema();
            spicedbHealthy = true;
          } catch {
            // SpiceDB unreachable
          }

          const status = {
            graphiti: graphitiHealthy ? "connected" : "unreachable",
            spicedb: spicedbHealthy ? "connected" : "unreachable",
            endpoint_graphiti: cfg.graphiti.endpoint,
            endpoint_spicedb: cfg.spicedb.endpoint,
            currentSessionId: currentSessionId ?? "none",
          };

          const statusText = [
            `Graphiti MCP: ${status.graphiti} (${status.endpoint_graphiti})`,
            `SpiceDB: ${status.spicedb} (${status.endpoint_spicedb})`,
            `Session: ${status.currentSessionId}`,
          ].join("\n");

          return {
            content: [{ type: "text", text: statusText }],
            details: status,
          };
        },
      },
      { name: "memory_status" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program
          .command("graphiti-mem")
          .description("Graphiti + SpiceDB memory plugin commands");
        registerCommands(mem, {
          graphiti,
          spicedb,
          cfg,
          currentSubject,
          getLastWriteToken: () => lastWriteToken,
        });
      },
      { commands: ["graphiti-mem"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        // Track session ID from hook context
        if (ctx?.sessionKey) {
          currentSessionId = ctx.sessionKey;
        }

        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject, lastWriteToken);
          if (authorizedGroups.length === 0) {
            return;
          }

          // Separate long-term and session groups
          const longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
          const sessionGroups = authorizedGroups.filter(isSessionGroup);

          // Include current session group if known
          if (currentSessionId) {
            const sg = sessionGroupId(currentSessionId);
            if (!sessionGroups.includes(sg)) {
              sessionGroups.push(sg);
            }
          }

          // Dual search: long-term + session in parallel
          const [longTermResults, rawSessionResults] = await Promise.all([
            longTermGroups.length > 0
              ? searchAuthorizedMemories(graphiti, {
                  query: event.prompt,
                  groupIds: longTermGroups,
                  limit: 5,
                })
              : Promise.resolve([]),
            sessionGroups.length > 0
              ? searchAuthorizedMemories(graphiti, {
                  query: event.prompt,
                  groupIds: sessionGroups,
                  limit: 3,
                })
              : Promise.resolve([]),
          ]);

          const sessionResults = deduplicateSessionResults(longTermResults, rawSessionResults);

          const totalCount = longTermResults.length + sessionResults.length;

          const toolHint =
            "<memory-tools>\n" +
            "You have knowledge-graph memory tools. Use them proactively:\n" +
            "- memory_recall: Search for facts, preferences, people, decisions, or past context. Use this BEFORE saying you don't know or remember something.\n" +
            "- memory_store: Save important new information (preferences, decisions, facts about people).\n" +
            "</memory-tools>";

          if (totalCount === 0) {
            return { prependContext: toolHint };
          }

          const memoryContext = formatDualResults(longTermResults, sessionResults);
          api.logger.info?.(
            `openclaw-memory-graphiti: injecting ${totalCount} memories (${longTermResults.length} long-term, ${sessionResults.length} session)`,
          );

          return {
            prependContext: `${toolHint}\n\n<relevant-memories>\nThe following memories from the knowledge graph may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`openclaw-memory-graphiti: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        // Track session ID from hook context
        if (ctx?.sessionKey) {
          currentSessionId = ctx.sessionKey;
        }

        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Collect last N messages (user + assistant only), skip injected context
          const maxMessages = cfg.maxCaptureMessages;
          const conversationLines: string[] = [];
          let messageCount = 0;

          // Process messages in reverse to get the most recent ones
          const messages = [...event.messages].reverse();

          for (const msg of messages) {
            if (messageCount >= maxMessages) break;
            if (!msg || typeof msg !== "object") continue;

            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            // Extract text content
            let text = "";
            const content = msgObj.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textParts: string[] = [];
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  textParts.push((block as Record<string, unknown>).text as string);
                }
              }
              text = textParts.join("\n");
            }

            // Skip injected context and very short messages
            if (!text || text.length < 5) continue;
            if (text.includes("<relevant-memories>")) continue;

            const roleLabel = role === "user" ? "User" : "Assistant";
            conversationLines.unshift(`${roleLabel}: ${text}`);
            messageCount++;
          }

          if (conversationLines.length === 0) return;

          // Send as a single batch episode to Graphiti
          const episodeBody = conversationLines.join("\n");

          // Store to session group by default (if session is known), otherwise default group
          const targetGroupId = currentSessionId
            ? sessionGroupId(currentSessionId)
            : cfg.graphiti.defaultGroupId;

          // Only auto-create membership for the agent's own current session
          const isOwnSession =
            isSessionGroup(targetGroupId) &&
            currentSessionId != null &&
            targetGroupId === sessionGroupId(currentSessionId);

          if (isOwnSession) {
            try {
              const token = await ensureGroupMembership(spicedb, targetGroupId, currentSubject);
              if (token) lastWriteToken = token;
            } catch {
              // Best-effort
            }
          } else {
            const allowed = await canWriteToGroup(spicedb, currentSubject, targetGroupId, lastWriteToken);
            if (!allowed) {
              api.logger.warn(`openclaw-memory-graphiti: auto-capture denied for group ${targetGroupId}`);
              return;
            }
          }

          const result = await graphiti.addEpisode({
            name: `auto_capture_${Date.now()}`,
            episode_body: episodeBody,
            source_description: "auto-captured conversation",
            group_id: targetGroupId,
            custom_extraction_instructions: cfg.customInstructions,
          });

          // SpiceDB writes use the real UUID once Graphiti finishes processing
          result.resolvedUuid
            .then(async (realUuid) => {
              const writeToken = await writeFragmentRelationships(spicedb, {
                fragmentId: realUuid,
                groupId: targetGroupId,
                sharedBy: currentSubject,
              });
              if (writeToken) lastWriteToken = writeToken;
            })
            .catch((err) => {
              api.logger.warn(
                `openclaw-memory-graphiti: deferred SpiceDB write (auto-capture) failed: ${err}`,
              );
            });

          api.logger.info(
            `openclaw-memory-graphiti: auto-captured ${conversationLines.length} messages as batch episode to ${targetGroupId}`,
          );
        } catch (err) {
          api.logger.warn(`openclaw-memory-graphiti: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-memory-graphiti",
      async start() {
        // Verify connectivity on startup
        const graphitiOk = await graphiti.healthCheck();
        let spicedbOk = false;
        try {
          const existing = await spicedb.readSchema();
          spicedbOk = true;

          // Auto-write schema if SpiceDB has no schema yet
          if (!existing || !existing.includes("memory_fragment")) {
            api.logger.info("openclaw-memory-graphiti: writing SpiceDB schema (first run)");
            const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
            const schema = readFileSync(schemaPath, "utf-8");
            await spicedb.writeSchema(schema);
            api.logger.info("openclaw-memory-graphiti: SpiceDB schema written successfully");
          }
        } catch {
          // Will be retried on first use
        }

        // Ensure current subject is a member of the default group
        if (spicedbOk) {
          try {
            const token = await ensureGroupMembership(
              spicedb,
              cfg.graphiti.defaultGroupId,
              currentSubject,
            );
            if (token) lastWriteToken = token;
          } catch {
            api.logger.warn("openclaw-memory-graphiti: failed to ensure default group membership");
          }
        }

        api.logger.info(
          `openclaw-memory-graphiti: initialized (graphiti: ${graphitiOk ? "OK" : "UNREACHABLE"}, spicedb: ${spicedbOk ? "OK" : "UNREACHABLE"})`,
        );
      },
      stop() {
        api.logger.info("openclaw-memory-graphiti: stopped");
      },
    });
  },
};

export default memoryGraphitiPlugin;
