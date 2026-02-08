# Changelog

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
