#!/usr/bin/env node
/**
 * Standalone CLI entry point for graphiti-mem commands.
 *
 * Reads config from environment variables and/or a JSON config file,
 * instantiates SpiceDB + Graphiti clients, and exposes the same commands
 * as the OpenClaw plugin — without requiring a running gateway.
 *
 * Usage:
 *   npx tsx bin/graphiti-mem.ts <command> [options]
 *   npm run cli -- <command> [options]
 */

import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { graphitiMemoryConfigSchema } from "../config.js";
import { GraphitiClient } from "../graphiti.js";
import { SpiceDbClient } from "../spicedb.js";
import { registerCommands } from "../cli.js";

// ============================================================================
// Config loading
// ============================================================================

function loadConfigFile(configPath?: string): Record<string, unknown> | null {
  const candidates = configPath
    ? [resolve(configPath)]
    : [
        resolve("graphiti-mem.config.json"),
        join(homedir(), ".config", "graphiti-mem", "config.json"),
      ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        console.error(`Failed to parse config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  }
  return null;
}

function loadConfigFromEnv(): Record<string, unknown> {
  const env = process.env;
  const config: Record<string, unknown> = {};

  // SpiceDB config
  const spicedb: Record<string, unknown> = {};
  if (env.GRAPHITI_MEM_SPICEDB_TOKEN ?? env.SPICEDB_TOKEN)
    spicedb.token = env.GRAPHITI_MEM_SPICEDB_TOKEN ?? env.SPICEDB_TOKEN;
  if (env.GRAPHITI_MEM_SPICEDB_ENDPOINT ?? env.SPICEDB_ENDPOINT)
    spicedb.endpoint = env.GRAPHITI_MEM_SPICEDB_ENDPOINT ?? env.SPICEDB_ENDPOINT;
  if (env.GRAPHITI_MEM_SPICEDB_INSECURE)
    spicedb.insecure = env.GRAPHITI_MEM_SPICEDB_INSECURE !== "false";
  if (Object.keys(spicedb).length > 0) config.spicedb = spicedb;

  // Graphiti config
  const graphiti: Record<string, unknown> = {};
  if (env.GRAPHITI_MEM_GRAPHITI_ENDPOINT ?? env.GRAPHITI_ENDPOINT)
    graphiti.endpoint = env.GRAPHITI_MEM_GRAPHITI_ENDPOINT ?? env.GRAPHITI_ENDPOINT;
  if (env.GRAPHITI_MEM_DEFAULT_GROUP_ID)
    graphiti.defaultGroupId = env.GRAPHITI_MEM_DEFAULT_GROUP_ID;
  if (Object.keys(graphiti).length > 0) config.graphiti = graphiti;

  // Top-level config
  if (env.GRAPHITI_MEM_SUBJECT_TYPE) config.subjectType = env.GRAPHITI_MEM_SUBJECT_TYPE;
  if (env.GRAPHITI_MEM_SUBJECT_ID) config.subjectId = env.GRAPHITI_MEM_SUBJECT_ID;

  return config;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key]) &&
      typeof override[key] === "object" && override[key] !== null && !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        override[key] as Record<string, unknown>,
      );
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// ============================================================================
// Main
// ============================================================================

const program = new Command()
  .name("graphiti-mem")
  .description("Standalone CLI for Graphiti + SpiceDB memory management")
  .option("--config <path>", "Path to config JSON file");

// Extract --config before subcommand parsing
const configIdx = process.argv.indexOf("--config");
const configPath = configIdx !== -1 ? process.argv[configIdx + 1] : undefined;

const fileConfig = loadConfigFile(configPath);
const envConfig = loadConfigFromEnv();

// Merge: env vars override file config, both override defaults
const mergedConfig = fileConfig
  ? deepMerge(fileConfig, envConfig)
  : envConfig;

let cfg;
try {
  cfg = graphitiMemoryConfigSchema.parse(mergedConfig);
} catch (err) {
  console.error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  console.error("\nProvide config via environment variables or a JSON config file.");
  console.error("Required: SPICEDB_TOKEN (or --config with spicedb.token)");
  process.exit(1);
}

const graphiti = new GraphitiClient(cfg.graphiti.endpoint);
const spicedb = new SpiceDbClient(cfg.spicedb);
const currentSubject = { type: cfg.subjectType, id: cfg.subjectId } as const;

registerCommands(program, {
  graphiti,
  spicedb,
  cfg,
  currentSubject,
  getLastWriteToken: () => undefined,
});

await program.parseAsync(process.argv);
