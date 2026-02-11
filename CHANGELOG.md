# Changelog

## 0.2.6 - 2026-02-11

### Fixed

- **Gateway shows unhelpful "config required" when plugin has no config key** (#33): The installer writes entries with no `config` key, so `pluginConfig` is `undefined` at startup. The config parser now accepts `undefined`/`null` (treating it as `{}` with all defaults) instead of throwing a generic error. This lets the flow reach `register()` which throws a clear error showing the exact JSON snippet to add to `~/.openclaw/openclaw.json`.

## 0.2.5 - 2026-02-11

### Fixed

- **`plugins install` still fails — JSON Schema in `openclaw.plugin.json` had `required` fields** (#33): The installer validates against the JSON Schema in `openclaw.plugin.json` (via ajv) *before* the TypeScript config parser runs. Removed `"required": ["spicedb"]` at the top level and `"required": ["token"]` inside the spicedb sub-schema. Added tests that walk the entire JSON Schema tree to prevent regressions.

## 0.2.4 - 2026-02-11

### Fixed

- **`plugins install` fails with "must have required property 'spicedb'"** (#33): Made the TypeScript config parser accept empty `config: {}` by defaulting all SpiceDB fields. The `spicedb.token` defaults to an empty string so install succeeds; on startup, `register()` checks for an empty token and throws a clear error directing the user to configure it in `~/.openclaw/openclaw.json`.
- **grpc-js unhandled rejection crashes gateway on startup**: The `@grpc/grpc-js` load balancer state machine can emit unhandled promise rejections during initial SpiceDB connection setup, crashing the Node.js process. Added a temporary `process.on('unhandledRejection')` guard that catches grpc-related rejections for the first 10 seconds after client creation, with proper cleanup in `stop()`.
- **Docker Compose Graphiti uses wrong FalkorDB host**: `FALKORDB_URI` in docker-compose.yml pointed to `host.docker.internal` instead of the `falkordb` service name, breaking inter-container connectivity.

## 0.2.3 - 2026-02-11

### Fixed

- **npm install fails with "openclaw.extensions is empty"**: Renamed plugin id from `memory-graphiti` to `openclaw-memory-graphiti` so it matches the idHint derived from the npm package name (`@contextableai/openclaw-memory-graphiti`). This allows restoring `openclaw.extensions: ["./index.ts"]` in package.json — the previous workaround of emptying the array caused the installer to reject the package. Updated all references: manifest, plugin registration, service id, log prefixes, config error messages, test expectations, path references (`extensions/openclaw-memory-graphiti`), and documentation.

## 0.2.1 - 2026-02-11

### Fixed

- **Colons in session group IDs break Graphiti**: `sessionGroupId()` now sanitizes invalid characters (colons, etc.) in OpenClaw `sessionKey` values (e.g. `agent:main:main` → `session-agent-main-main`), fixing silent episode creation failures and FalkorDB RediSearch syntax errors
- **SpiceDB schema written on every startup**: the auto-write guard checked for `memory_group` which doesn't exist in the schema — changed to `memory_fragment` so the schema is only written on first run
- **UUID resolution polling times out before Graphiti finishes processing**: Increased polling timeout from 30s (15 polls x 2s) to 90s (30 polls x 3s) — Graphiti's LLM entity extraction takes 10-37s in practice ([getzep/graphiti#356](https://github.com/getzep/graphiti/issues/356)), so the old 30s window failed ~25-50% of the time. Added diagnostic logging to polling loop for debugging.
- **LLM confuses node UUIDs with deletable IDs**: `factToResult` was falling back to bare `source_node_uuid`/`target_node_uuid` when node names were null, leaking raw node UUIDs into formatted search results. The LLM would then pass these to `memory_forget`, causing "Permission denied" errors. Now falls back to `"?"` instead of exposing node UUIDs.
- **Empty Graphiti group_id crashes SpiceDB permission check**: Graphiti allows empty-string `group_id` (its default for some backends like FalkorDB), but SpiceDB ObjectIds require at least one character. `memory_forget` now maps empty `group_id` to the configured `defaultGroupId` before the permission check.

### Changed

- **`memory_forget` simplified to fact-only deletion**: Replaced separate `episode_id`/`fact_id` parameters with a single `id` parameter that parses type prefixes from `memory_recall` output (e.g. `fact:UUID`). Episode deletion removed from the agent-facing tool — it's an admin operation available via CLI (`graphiti-mem cleanup`). This reduces tool complexity for the LLM and eliminates the class of bugs where bare UUIDs (nodes, facts) were passed as episode IDs.
- **Search results use type-prefixed UUIDs**: Formatted output now shows `[fact:UUID]` and `[entity:UUID]` instead of bare `[fact]`/`[entity]` labels, so the LLM knows exactly which ID to pass to `memory_forget` and which deletion method applies.
- **Fact context shows relationship names**: Facts with named edges now display as `Source -[RELATIONSHIP]→ Target` instead of just `Source → Target`.

### Added

- **Configurable UUID polling timeout**: `graphiti.uuidPollIntervalMs` (default 3000) and `graphiti.uuidPollMaxAttempts` (default 30) config options — controls how long the deferred SpiceDB write waits for Graphiti to finish LLM processing after `memory_store`
- **Episode UUID prefixes**: Graphiti MCP server configured with `EPISODE_ID_PREFIX=epi-` and client-side tracking UUIDs use `tmp-` prefix for disambiguation in logs.

## 0.2.0 - 2026-02-11

### Added

- `getEntityEdge`, `deleteEntityEdge`, and `clearGraph` methods on `GraphitiClient` — wrapping the previously unused `get_entity_edge`, `delete_entity_edge`, and `clear_graph` MCP server tools
- `entity_types` filter parameter on `searchNodes` — filters results by entity classification (e.g. Preference, Organization, Procedure)
- `center_node_uuid` parameter on `searchFacts` — anchors fact search around a specific entity node ("tell me everything about X")
- `entity_types` and `center_node_uuid` optional parameters on the `memory_recall` agent tool, threaded through to Graphiti search calls
- `memory_forget` now supports deleting individual facts via a new `fact_id` parameter — fetches the fact to determine its `group_id`, checks `canWriteToGroup` authorization, then deletes the entity edge
- `graphiti-mem fact <uuid>` CLI command — fetch and display a specific fact (entity edge) by UUID as JSON
- `graphiti-mem clear-graph` CLI command — clear graph data for specified groups; requires `--confirm` safety flag, supports `--group <id...>` to target specific groups
- `graphiti-mem cleanup` CLI command to find and optionally delete orphaned Graphiti episodes — episodes that exist in Graphiti but have no `source_group` relationship in SpiceDB (can happen when Phase 2 of a two-phase import fails). Supports `--group`, `--last`, `--delete`, and `--dry-run` flags.
- `readRelationships` method on `SpiceDbClient` for querying existing authorization tuples by resource type, relation, and subject filter
- Bulk import: `graphiti-mem import` now uses two-phase approach — Graphiti ingestion first, then a single `BulkImportRelationships` streaming RPC to SpiceDB (with batched `WriteRelationships` fallback), replacing per-file interleaved writes
- ZedToken consistency tuning: SpiceDB reads after writes now use `at_least_as_fresh` consistency with the token from the preceding write, ensuring causal consistency without the cost of `fully_consistent`; reads without a prior write use `minimize_latency` for optimal performance

### Changed

- `memory_forget` tool: `episode_id` is now optional — callers must provide either `episode_id` or `fact_id` (not both)
- Docker image updated from stale `ghcr.io/getzep/graphiti-mcp:latest` to `zepai/knowledge-graph-mcp:latest`, matching the upstream Graphiti project's published image

### Fixed

- **UUID mismatch between Graphiti and SpiceDB**: `addEpisode` now polls `getEpisodes` in the background to resolve the real server-side UUID assigned by Graphiti (the MCP `add_memory` tool only returns a "queued" message, not the UUID). SpiceDB authorization relationships are written with the real UUID once resolved, fixing broken fragment-level authorization (`memory_forget`, `canDeleteFragment`, `lookupViewableFragments`). The polling is non-blocking — `memory_store` and auto-capture return immediately while SpiceDB writes happen in the background; `graphiti-mem import` awaits all UUIDs before Phase 2 bulk write.
- `memory_forget` now uses filter-based `DeleteRelationships` RPC to clean up SpiceDB relationships, fixing orphaned tuples when deleting fragments stored to non-default groups or by other subjects
- Flaky "batch conversation capture extracts entities" E2E test — replaced fixed 20s sleep with a polling loop (up to 8 attempts at 5s intervals) to handle variable Graphiti extraction queue latency

### Internal

- Extracted `mcpUrl` getter in `GraphitiClient` for single-point trailing slash adjustment across all 4 MCP endpoint references

## 0.1.2 - 2026-02-09

### Added

- `openclaw.install` metadata in package.json for one-liner installation via `openclaw plugins install @contextableai/openclaw-memory-graphiti`
- Auto-write SpiceDB schema on first gateway start (no manual `schema-write` needed)
- Docker Compose profiles: `docker compose up -d` now starts infrastructure only; gateway opt-in via `--profile gateway`
- Updated README with installation instructions and simplified quick start

## 0.1.1 - 2026-02-09

### Added

- `--sessions-only` flag for `graphiti-mem import` to import session transcripts without re-importing workspace files
- `<memory-tools>` hint block injected via `before_agent_start` hook so LLMs proactively use `memory_recall`/`memory_store` (the hardcoded system prompt only recognizes memory-core tool names)
- Persistent SpiceDB storage via PostgreSQL in Docker Compose (`postgres` service + `spicedb-migrate` init container)
- `graphiti-mem import` CLI command for migrating workspace markdown files and session transcripts into Graphiti
- OpenClaw integration section in README

### Fixed

- JSONL session transcript parser now handles OpenClaw's nested message format (`{"type":"message","message":{"role":"user","content":[...]}}`)
- Auto-capture filters `<memory-tools>` tags alongside `<relevant-memories>` to prevent feedback loops
- `before_agent_start` hook returns tool hint even when no memories are found (was returning nothing)

## 0.1.0 - Initial Release

Two-layer memory plugin for OpenClaw combining SpiceDB authorization with Graphiti knowledge graph storage.

### Features

- **memory_recall** tool — search entities and facts across authorized groups with session/long-term/all scoping
- **memory_store** tool — save memories with automatic entity and fact extraction via Graphiti
- **memory_forget** tool — delete memories with permission checks (only the creator can delete)
- **memory_status** tool — health checks for Graphiti and SpiceDB connectivity
- **Auto-recall** — automatically inject relevant memories into conversation context before each agent turn
- **Auto-capture** — automatically extract and store key information from completed conversations
- **Parallel multi-group search** — fan-out search across all authorized groups with deduplication and recency ranking
- **Session memory isolation** — per-conversation session groups with exclusive agent ownership
- **Write-side authorization** — SpiceDB `contribute` permission prevents unauthorized memory injection into foreign groups
- **Read-side authorization** — SpiceDB `access` permission controls which groups a subject can search
- **Delete authorization** — only the subject who stored a memory can delete it
- **Custom extraction instructions** — configurable rules for what Graphiti extracts from conversations
- **Environment variable interpolation** — `${ENV_VAR}` syntax in config values
- **CLI commands** — `graphiti-mem` subcommands for search, episodes, status, schema management, and group membership
- **Docker Compose stack** — full infrastructure: FalkorDB, Graphiti MCP, SpiceDB, and OpenClaw gateway
- **Dev scripts** — setup, start, stop, and status scripts for local development
