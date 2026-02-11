# Changelog

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
