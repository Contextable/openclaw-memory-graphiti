/**
 * Shared CLI command registration for graphiti-mem.
 *
 * Used by both the OpenClaw plugin (index.ts) and the standalone CLI (bin/graphiti-mem.ts).
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { GraphitiClient } from "./graphiti.js";
import type { SpiceDbClient, RelationshipTuple } from "./spicedb.js";
import type { GraphitiMemoryConfig } from "./config.js";
import {
  lookupAuthorizedGroups,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";
import { searchAuthorizedMemories } from "./search.js";

// ============================================================================
// Session helpers (duplicated from index.ts to avoid circular imports)
// ============================================================================

function sessionGroupId(sessionId: string): string {
  return `session-${sessionId}`;
}

// ============================================================================
// CLI Context
// ============================================================================

export type CliContext = {
  graphiti: GraphitiClient;
  spicedb: SpiceDbClient;
  cfg: GraphitiMemoryConfig;
  currentSubject: Subject;
  getLastWriteToken: () => string | undefined;
};

// ============================================================================
// Command Registration
// ============================================================================

export function registerCommands(cmd: Command, ctx: CliContext): void {
  const { graphiti, spicedb, cfg, currentSubject, getLastWriteToken } = ctx;

  cmd
    .command("search")
    .description("Search memories with authorization")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", "10")
    .option("--scope <scope>", "Memory scope: session, long-term, all", "all")
    .action(async (query: string, opts: { limit: string; scope: string }) => {
      const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject, getLastWriteToken());
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

  cmd
    .command("episodes")
    .description("List recent episodes")
    .option("--last <n>", "Number of episodes", "10")
    .option("--group <id>", "Group ID", cfg.graphiti.defaultGroupId)
    .action(async (opts: { last: string; group: string }) => {
      const episodes = await graphiti.getEpisodes(opts.group, parseInt(opts.last));
      console.log(JSON.stringify(episodes, null, 2));
    });

  cmd
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

  cmd
    .command("schema-write")
    .description("Write/update SpiceDB authorization schema")
    .action(async () => {
      const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
      const schema = readFileSync(schemaPath, "utf-8");
      await spicedb.writeSchema(schema);
      console.log("SpiceDB schema written successfully.");
    });

  cmd
    .command("groups")
    .description("List authorized groups for current subject")
    .action(async () => {
      const groups = await lookupAuthorizedGroups(spicedb, currentSubject, getLastWriteToken());
      if (groups.length === 0) {
        console.log("No authorized groups.");
        return;
      }
      console.log(`Authorized groups for ${currentSubject.type}:${currentSubject.id}:`);
      for (const g of groups) {
        console.log(`  - ${g}`);
      }
    });

  cmd
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

  cmd
    .command("cleanup")
    .description("Find and optionally delete orphaned Graphiti episodes (no SpiceDB relationships)")
    .option("--group <id>", "Group ID to check", cfg.graphiti.defaultGroupId)
    .option("--last <n>", "Number of recent episodes to check", "100")
    .option("--delete", "Delete orphaned episodes", false)
    .option("--dry-run", "Preview what would be cleaned up", false)
    .action(async (opts: { group: string; last: string; delete: boolean; dryRun: boolean }) => {
      // 1. Fetch episodes from Graphiti for this group
      const episodes = await graphiti.getEpisodes(opts.group, parseInt(opts.last));

      if (episodes.length === 0) {
        console.log(`No episodes found in group "${opts.group}".`);
        return;
      }

      // 2. Cross-reference with SpiceDB: find all memory_fragment source_group
      //    relationships pointing to this group
      const relationships = await spicedb.readRelationships({
        resourceType: "memory_fragment",
        relation: "source_group",
        subjectType: "group",
        subjectId: opts.group,
      });

      const authorizedUuids = new Set(relationships.map((r) => r.resourceId));

      // 3. Identify orphans — episodes without a source_group relationship
      const orphans = episodes.filter((ep) => !authorizedUuids.has(ep.uuid));

      if (orphans.length === 0) {
        console.log(
          `Checked ${episodes.length} episodes in group "${opts.group}". No orphans found.`,
        );
        return;
      }

      console.log(`Found ${orphans.length} orphaned episodes:`);
      for (const ep of orphans) {
        console.log(`  ${ep.uuid} (created ${ep.created_at}, no SpiceDB relationships)`);
      }

      // 4. Delete if requested (and not dry-run)
      if (opts.delete && !opts.dryRun) {
        let deleted = 0;
        for (const ep of orphans) {
          try {
            await graphiti.deleteEpisode(ep.uuid);
            deleted++;
          } catch (err) {
            console.error(
              `  Failed to delete ${ep.uuid}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        console.log(`Deleted ${deleted} orphaned episodes.`);
      } else {
        console.log(`\nRun with --delete to remove these episodes.`);
      }
    });

  cmd
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

      // Two-phase import:
      //   Phase 1 — Graphiti ingestion: addEpisode for each file, collect results
      //   Phase 2 — SpiceDB bulk: single bulkImportRelationships call for all tuples
      // This is more efficient than interleaving and leaves SpiceDB in a clean
      // state if Graphiti ingestion fails partway (orphaned episodes are invisible
      // without authorization).

      // Collect resolvedUuid promises during Phase 1 so we can await
      // real server-side UUIDs before writing SpiceDB relationships.
      const pendingResolutions: { resolvedUuid: Promise<string>; groupId: string; name: string }[] = [];
      const membershipGroups = new Set<string>();

      // Ensure agent is a member of the target workspace group
      if (importWorkspace) {
        cmdbershipGroups.add(targetGroup);
      }

      // Phase 1a: Import workspace files to Graphiti
      if (importWorkspace) {
        console.log(`\nPhase 1: Importing workspace files to Graphiti (group: ${targetGroup})...`);
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
            pendingResolutions.push({
              resolvedUuid: result.resolvedUuid,
              groupId: targetGroup,
              name: f,
            });
            console.log(`  Queued ${f} (${content.length} bytes) — resolving UUID in background`);
            imported++;
          } catch (err) {
            console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        console.log(`Workspace: ${imported}/${mdFiles.length} files ingested.`);
      }

      // Phase 1b: Import session transcripts to Graphiti
      if (importSessions) {
        const sessionPath = resolve(opts.sessionDir);
        let jsonlFiles: string[] = [];
        try {
          jsonlFiles = (await readdir(sessionPath)).filter((f) => f.endsWith(".jsonl")).sort();
        } catch {
          console.error(`\nCannot read session directory: ${sessionPath}`);
          // Continue to Phase 2 with whatever tuples we have
          jsonlFiles = [];
        }

        if (jsonlFiles.length === 0) {
          console.log("\nNo session transcripts found.");
        } else {
          console.log(`\nPhase 1: Importing ${jsonlFiles.length} session transcript(s) to Graphiti...`);
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
              const episodeBody = conversationLines.join("\n");
              const result = await graphiti.addEpisode({
                name: `session_${sessionId}`,
                episode_body: episodeBody,
                source_description: `Imported session transcript: ${sessionId}`,
                group_id: sessionGroup,
                source: "message",
              });
              cmdbershipGroups.add(sessionGroup);
              pendingResolutions.push({
                resolvedUuid: result.resolvedUuid,
                groupId: sessionGroup,
                name: f,
              });
              console.log(`  Queued ${f} (${conversationLines.length} messages) — resolving UUID in background [group: ${sessionGroup}]`);
              sessionsImported++;
            } catch (err) {
              console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          console.log(`Sessions: ${sessionsImported}/${jsonlFiles.length} transcripts ingested.`);
        }
      }

      // Phase 1.5: Await real server-side UUIDs from Graphiti.
      // The background polls started during Phase 1 run concurrently,
      // so the total wait is max(processing time) not sum.
      const pendingTuples: RelationshipTuple[] = [];
      if (pendingResolutions.length > 0) {
        console.log(`\nResolving ${pendingResolutions.length} episode UUIDs (waiting for Graphiti processing)...`);
        const results = await Promise.allSettled(
          pendingResolutions.map((p) => p.resolvedUuid),
        );
        for (let i = 0; i < results.length; i++) {
          const resolution = results[i];
          if (resolution.status === "fulfilled") {
            const realUuid = resolution.value;
            pendingTuples.push(
              {
                resourceType: "memory_fragment",
                resourceId: realUuid,
                relation: "source_group",
                subjectType: "group",
                subjectId: pendingResolutions[i].groupId,
              },
              {
                resourceType: "memory_fragment",
                resourceId: realUuid,
                relation: "shared_by",
                subjectType: currentSubject.type,
                subjectId: currentSubject.id,
              },
            );
            console.log(`  ${pendingResolutions[i].name} → ${realUuid}`);
          } else {
            console.warn(`  Warning: could not resolve UUID for ${pendingResolutions[i].name} — SpiceDB linkage skipped`);
          }
        }
      }

      // Phase 2: Bulk write all SpiceDB relationships
      if (pendingTuples.length > 0 || membershipGroups.size > 0) {
        // Add group membership tuples for session groups
        for (const groupId of membershipGroups) {
          pendingTuples.push({
            resourceType: "group",
            resourceId: groupId,
            relation: "member",
            subjectType: currentSubject.type,
            subjectId: currentSubject.id,
          });
        }

        console.log(`\nPhase 2: Writing ${pendingTuples.length} SpiceDB relationships...`);
        try {
          const count = await spicedb.bulkImportRelationships(pendingTuples);
          console.log(`SpiceDB: ${count} relationships written.`);
        } catch (err) {
          console.error(`SpiceDB bulk import failed: ${err instanceof Error ? err.message : String(err)}`);
          console.error("Graphiti episodes were ingested but lack authorization. Re-run import or add relationships manually.");
        }
      }

      console.log("\nImport complete.")
    });
}
