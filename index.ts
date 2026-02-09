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
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { graphitiMemoryConfigSchema } from "./config.js";
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
import {
  searchAuthorizedMemories,
  formatDualResults,
  deduplicateSessionResults,
} from "./search.js";

// ============================================================================
// Session helpers
// ============================================================================

function sessionGroupId(sessionId: string): string {
  // Use dash separator — Graphiti group_ids only allow alphanumeric, dashes, underscores
  return `session-${sessionId}`;
}

function isSessionGroup(groupId: string): boolean {
  return groupId.startsWith("session-");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryGraphitiPlugin = {
  id: "memory-graphiti",
  name: "Memory (Graphiti + SpiceDB)",
  description: "Two-layer memory: SpiceDB authorization + Graphiti knowledge graph",
  kind: "memory" as const,
  configSchema: graphitiMemoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = graphitiMemoryConfigSchema.parse(api.pluginConfig);

    const graphiti = new GraphitiClient(cfg.graphiti.endpoint);
    const spicedb = new SpiceDbClient(cfg.spicedb);

    const currentSubject: Subject = {
      type: cfg.subjectType,
      id: cfg.subjectId,
    };

    // Track current session ID — updated from hook event context
    let currentSessionId: string | undefined;

    api.logger.info(
      `memory-graphiti: registered (graphiti: ${cfg.graphiti.endpoint}, spicedb: ${cfg.spicedb.endpoint})`,
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
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10, scope = "all" } = params as {
            query: string;
            limit?: number;
            scope?: "session" | "long-term" | "all";
          };

          // 1. Get authorized groups for current subject
          const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject);

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
          const [longTermResults, rawSessionResults] = await Promise.all([
            longTermGroups.length > 0
              ? searchAuthorizedMemories(graphiti, { query, groupIds: longTermGroups, limit })
              : Promise.resolve([]),
            sessionGroups.length > 0
              ? searchAuthorizedMemories(graphiti, { query, groupIds: sessionGroups, limit })
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
              await ensureGroupMembership(spicedb, targetGroupId, currentSubject);
            } catch {
              api.logger.warn(`memory-graphiti: failed to ensure membership in ${targetGroupId}`);
            }
          } else {
            // All other groups (non-session AND foreign session) require write permission
            const allowed = await canWriteToGroup(spicedb, currentSubject, targetGroupId);
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

          const fragmentId = result.episode_uuid;

          // 2. Write authorization relationships in SpiceDB
          const involvedSubjects: Subject[] = involves.map((id) => ({
            type: "person" as const,
            id,
          }));

          await writeFragmentRelationships(spicedb, {
            fragmentId,
            groupId: targetGroupId,
            sharedBy: currentSubject,
            involves: involvedSubjects,
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
              episodeId: fragmentId,
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
        description: "Delete a memory episode. Requires delete permission.",
        parameters: Type.Object({
          episode_id: Type.String({ description: "Episode UUID to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { episode_id } = params as { episode_id: string };

          // 1. Check delete permission
          const allowed = await canDeleteFragment(spicedb, currentSubject, episode_id);
          if (!allowed) {
            return {
              content: [
                {
                  type: "text",
                  text: `Permission denied: cannot delete episode ${episode_id}`,
                },
              ],
              details: { action: "denied", episodeId: episode_id },
            };
          }

          // 2. Delete from Graphiti
          await graphiti.deleteEpisode(episode_id);

          // 3. Clean up SpiceDB relationships (best-effort)
          try {
            await deleteFragmentRelationships(spicedb, episode_id, {
              fragmentId: episode_id,
              groupId: cfg.graphiti.defaultGroupId,
              sharedBy: currentSubject,
            });
          } catch {
            api.logger.warn(
              `memory-graphiti: failed to clean up SpiceDB relationships for ${episode_id}`,
            );
          }

          return {
            content: [{ type: "text", text: `Memory ${episode_id} forgotten.` }],
            details: { action: "deleted", episodeId: episode_id },
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

        mem
          .command("search")
          .description("Search memories with authorization")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .option("--scope <scope>", "Memory scope: session, long-term, all", "all")
          .action(async (query: string, opts: { limit: string; scope: string }) => {
            const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject);
            if (authorizedGroups.length === 0) {
              console.log("No accessible memory groups.");
              return;
            }

            console.log(`Searching ${authorizedGroups.length} authorized groups...`);
            const results = await searchAuthorizedMemories(graphiti, {
              query,
              groupIds: authorizedGroups,
              limit: parseInt(opts.limit),
            });

            if (results.length === 0) {
              console.log("No results found.");
              return;
            }

            console.log(JSON.stringify(results, null, 2));
          });

        mem
          .command("episodes")
          .description("List recent episodes")
          .option("--last <n>", "Number of episodes", "10")
          .option("--group <id>", "Group ID", cfg.graphiti.defaultGroupId)
          .action(async (opts: { last: string; group: string }) => {
            const episodes = await graphiti.getEpisodes(opts.group, parseInt(opts.last));
            console.log(JSON.stringify(episodes, null, 2));
          });

        mem
          .command("status")
          .description("Check SpiceDB + Graphiti health")
          .action(async () => {
            const graphitiOk = await graphiti.healthCheck();
            let spicedbOk = false;
            try {
              await spicedb.readSchema();
              spicedbOk = true;
            } catch {
              // unreachable
            }

            console.log(`Graphiti MCP: ${graphitiOk ? "OK" : "UNREACHABLE"} (${cfg.graphiti.endpoint})`);
            console.log(`SpiceDB:      ${spicedbOk ? "OK" : "UNREACHABLE"} (${cfg.spicedb.endpoint})`);
          });

        mem
          .command("schema-write")
          .description("Write/update SpiceDB authorization schema")
          .action(async () => {
            const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
            const schema = readFileSync(schemaPath, "utf-8");
            await spicedb.writeSchema(schema);
            console.log("SpiceDB schema written successfully.");
          });

        mem
          .command("groups")
          .description("List authorized groups for current subject")
          .action(async () => {
            const groups = await lookupAuthorizedGroups(spicedb, currentSubject);
            if (groups.length === 0) {
              console.log("No authorized groups.");
              return;
            }
            console.log(`Authorized groups for ${currentSubject.type}:${currentSubject.id}:`);
            for (const g of groups) {
              console.log(`  - ${g}`);
            }
          });

        mem
          .command("add-member")
          .description("Add a subject to a group")
          .argument("<group-id>", "Group ID")
          .argument("<subject-id>", "Subject ID")
          .option("--type <type>", "Subject type (agent|person)", "person")
          .action(async (groupId: string, subjectId: string, opts: { type: string }) => {
            const subjectType = opts.type === "agent" ? "agent" : "person";
            await ensureGroupMembership(spicedb, groupId, {
              type: subjectType as "agent" | "person",
              id: subjectId,
            });
            console.log(`Added ${subjectType}:${subjectId} to group:${groupId}`);
          });

        mem
          .command("import")
          .description("Import workspace markdown files (and optionally session transcripts) into Graphiti")
          .option("--workspace <path>", "Workspace directory", join(homedir(), ".openclaw", "workspace"))
          .option("--include-sessions", "Also import session JSONL transcripts", false)
          .option("--sessions-only", "Only import session transcripts (skip workspace files)", false)
          .option("--session-dir <path>", "Session transcripts directory", join(homedir(), ".openclaw", "agents", "main", "sessions"))
          .option("--group <id>", "Target group for workspace files", cfg.graphiti.defaultGroupId)
          .option("--dry-run", "List files without importing", false)
          .action(async (opts: {
            workspace: string;
            includeSessions: boolean;
            sessionsOnly: boolean;
            sessionDir: string;
            group: string;
            dryRun: boolean;
          }) => {
            const workspacePath = resolve(opts.workspace);
            const targetGroup = opts.group;
            const importSessions = opts.includeSessions || opts.sessionsOnly;
            const importWorkspace = !opts.sessionsOnly;

            // Discover workspace markdown files
            let mdFiles: string[] = [];
            try {
              const entries = await readdir(workspacePath);
              mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
            } catch {
              console.error(`Cannot read workspace directory: ${workspacePath}`);
              return;
            }

            // Also check for memory/ subdirectory
            try {
              const memDir = join(workspacePath, "memory");
              const memEntries = await readdir(memDir);
              for (const f of memEntries) {
                if (f.endsWith(".md")) {
                  mdFiles.push(join("memory", f));
                }
              }
            } catch {
              // No memory/ subdirectory — that's fine
            }

            if (mdFiles.length === 0) {
              console.log("No markdown files found in workspace.");
              return;
            }

            console.log(`Found ${mdFiles.length} workspace file(s) in ${workspacePath}:`);
            for (const f of mdFiles) {
              const filePath = join(workspacePath, f);
              const info = await stat(filePath);
              console.log(`  ${f} (${info.size} bytes)`);
            }

            if (opts.dryRun) {
              console.log("\n[dry-run] No files imported.");
              if (importSessions) {
                const sessionPath = resolve(opts.sessionDir);
                try {
                  const sessions = (await readdir(sessionPath)).filter((f) => f.endsWith(".jsonl"));
                  console.log(`\nFound ${sessions.length} session transcript(s) in ${sessionPath}:`);
                  for (const f of sessions) {
                    const info = await stat(join(sessionPath, f));
                    console.log(`  ${f} (${info.size} bytes)`);
                  }
                } catch {
                  console.log(`\nCannot read session directory: ${sessionPath}`);
                }
              }
              return;
            }

            // Import workspace files
            if (importWorkspace) {
              console.log(`\nImporting workspace files to group: ${targetGroup}`);
              let imported = 0;
              for (const f of mdFiles) {
                const filePath = join(workspacePath, f);
                const content = await readFile(filePath, "utf-8");
                if (!content.trim()) {
                  console.log(`  Skipping ${f} (empty)`);
                  continue;
                }
                try {
                  const result = await graphiti.addEpisode({
                    name: f,
                    episode_body: content,
                    source_description: `Imported from OpenClaw workspace: ${f}`,
                    group_id: targetGroup,
                    source: "text",
                  });
                  await writeFragmentRelationships(spicedb, {
                    fragmentId: result.episode_uuid,
                    groupId: targetGroup,
                    sharedBy: currentSubject,
                  });
                  console.log(`  Imported ${f} (${content.length} bytes) → episode ${result.episode_uuid}`);
                  imported++;
                } catch (err) {
                  console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              console.log(`\nWorkspace import complete: ${imported}/${mdFiles.length} files.`);
            }

            // Import session transcripts
            if (importSessions) {
              const sessionPath = resolve(opts.sessionDir);
              let jsonlFiles: string[] = [];
              try {
                jsonlFiles = (await readdir(sessionPath)).filter((f) => f.endsWith(".jsonl")).sort();
              } catch {
                console.error(`\nCannot read session directory: ${sessionPath}`);
                return;
              }

              if (jsonlFiles.length === 0) {
                console.log("\nNo session transcripts found.");
                return;
              }

              console.log(`\nImporting ${jsonlFiles.length} session transcript(s)...`);
              let sessionsImported = 0;
              for (const f of jsonlFiles) {
                const sessionId = basename(f, ".jsonl");
                const sessionGroup = sessionGroupId(sessionId);
                const filePath = join(sessionPath, f);
                const raw = await readFile(filePath, "utf-8");
                const lines = raw.split("\n").filter(Boolean);

                // Extract user/assistant message text from JSONL
                const conversationLines: string[] = [];
                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line) as Record<string, unknown>;
                    // OpenClaw JSONL format: {"type":"message","message":{"role":"user","content":[...]}}
                    const msg = (entry.type === "message" && entry.message && typeof entry.message === "object")
                      ? entry.message as Record<string, unknown>
                      : entry;
                    const role = msg.role as string | undefined;
                    if (role !== "user" && role !== "assistant") continue;
                    const content = msg.content;
                    let text = "";
                    if (typeof content === "string") {
                      text = content;
                    } else if (Array.isArray(content)) {
                      text = content
                        .filter((b: unknown) =>
                          typeof b === "object" && b !== null &&
                          (b as Record<string, unknown>).type === "text" &&
                          typeof (b as Record<string, unknown>).text === "string",
                        )
                        .map((b: unknown) => (b as Record<string, unknown>).text as string)
                        .join("\n");
                    }
                    if (text && text.length >= 5 && !text.includes("<relevant-memories>") && !text.includes("<memory-tools>")) {
                      const roleLabel = role === "user" ? "User" : "Assistant";
                      conversationLines.push(`${roleLabel}: ${text}`);
                    }
                  } catch {
                    // Skip malformed JSONL lines
                  }
                }

                if (conversationLines.length === 0) {
                  console.log(`  Skipping ${f} (no user/assistant messages)`);
                  continue;
                }

                try {
                  await ensureGroupMembership(spicedb, sessionGroup, currentSubject);
                  const episodeBody = conversationLines.join("\n");
                  const result = await graphiti.addEpisode({
                    name: `session_${sessionId}`,
                    episode_body: episodeBody,
                    source_description: `Imported session transcript: ${sessionId}`,
                    group_id: sessionGroup,
                    source: "message",
                  });
                  await writeFragmentRelationships(spicedb, {
                    fragmentId: result.episode_uuid,
                    groupId: sessionGroup,
                    sharedBy: currentSubject,
                  });
                  console.log(`  Imported ${f} (${conversationLines.length} messages) → episode ${result.episode_uuid} [group: ${sessionGroup}]`);
                  sessionsImported++;
                } catch (err) {
                  console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              console.log(`\nSession import complete: ${sessionsImported}/${jsonlFiles.length} transcripts.`);
            }
          });
      },
      { commands: ["graphiti-mem"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        // Track session ID from event context
        if (event.ctx?.sessionKey) {
          currentSessionId = event.ctx.sessionKey as string;
        }

        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        try {
          const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject);
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
            `memory-graphiti: injecting ${totalCount} memories (${longTermResults.length} long-term, ${sessionResults.length} session)`,
          );

          return {
            prependContext: `${toolHint}\n\n<relevant-memories>\nThe following memories from the knowledge graph may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-graphiti: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        // Track session ID from event context
        if (event.ctx?.sessionKey) {
          currentSessionId = event.ctx.sessionKey as string;
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
              await ensureGroupMembership(spicedb, targetGroupId, currentSubject);
            } catch {
              // Best-effort
            }
          } else {
            const allowed = await canWriteToGroup(spicedb, currentSubject, targetGroupId);
            if (!allowed) {
              api.logger.warn(`memory-graphiti: auto-capture denied for group ${targetGroupId}`);
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

          await writeFragmentRelationships(spicedb, {
            fragmentId: result.episode_uuid,
            groupId: targetGroupId,
            sharedBy: currentSubject,
          });

          api.logger.info(
            `memory-graphiti: auto-captured ${conversationLines.length} messages as batch episode to ${targetGroupId}`,
          );
        } catch (err) {
          api.logger.warn(`memory-graphiti: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-graphiti",
      async start() {
        // Verify connectivity on startup
        const graphitiOk = await graphiti.healthCheck();
        let spicedbOk = false;
        try {
          const existing = await spicedb.readSchema();
          spicedbOk = true;

          // Auto-write schema if SpiceDB has no schema yet
          if (!existing || !existing.includes("memory_group")) {
            api.logger.info("memory-graphiti: writing SpiceDB schema (first run)");
            const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
            const schema = readFileSync(schemaPath, "utf-8");
            await spicedb.writeSchema(schema);
            api.logger.info("memory-graphiti: SpiceDB schema written successfully");
          }
        } catch {
          // Will be retried on first use
        }

        // Ensure current subject is a member of the default group
        if (spicedbOk) {
          try {
            await ensureGroupMembership(
              spicedb,
              cfg.graphiti.defaultGroupId,
              currentSubject,
            );
          } catch {
            api.logger.warn("memory-graphiti: failed to ensure default group membership");
          }
        }

        api.logger.info(
          `memory-graphiti: initialized (graphiti: ${graphitiOk ? "OK" : "UNREACHABLE"}, spicedb: ${spicedbOk ? "OK" : "UNREACHABLE"})`,
        );
      },
      stop() {
        api.logger.info("memory-graphiti: stopped");
      },
    });
  },
};

export default memoryGraphitiPlugin;
