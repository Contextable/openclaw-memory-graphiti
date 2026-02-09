# Changelog

## 0.1.2 - 2026-02-09

### Added

- `openclaw.install` metadata in package.json for one-liner installation via `openclaw plugins install @contextableai/openclaw-memory-graphiti`
- Auto-write SpiceDB schema on first gateway start (no manual `schema-write` needed)
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
