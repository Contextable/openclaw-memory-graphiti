# @contextableai/openclaw-memory-graphiti

Two-layer memory plugin for OpenClaw: **SpiceDB** for authorization, **Graphiti** for knowledge graph storage.

Agents remember conversations as structured entities and facts in a knowledge graph. SpiceDB enforces who can read and write which memories — authorization is at the data layer, not in prompts.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    OpenClaw Agent                 │
│                                                  │
│  memory_recall ──► SpiceDB ──► Graphiti Search   │
│  memory_store  ──► SpiceDB ──► Graphiti Write    │
│  memory_forget ──► SpiceDB ──► Graphiti Delete   │
│  auto-recall   ──► SpiceDB ──► Graphiti Search   │
│  auto-capture  ──► SpiceDB ──► Graphiti Write    │
└──────────────────────────────────────────────────┘
         │                           │
    ┌────▼────┐                ┌─────▼─────┐
    │ SpiceDB │                │  Graphiti  │
    │  (authz) │                │ MCP Server │
    └─────────┘                └─────┬─────┘
                                     │
                               ┌─────▼─────┐
                               │  FalkorDB  │
                               │  (graph)   │
                               └───────────┘
```

**SpiceDB** determines which `group_id`s a subject (agent or person) can access, then **Graphiti** searches or stores memories scoped to those groups.

## Installation

```bash
openclaw plugins install @contextableai/openclaw-memory-graphiti
```

Or with npm:

```bash
npm install @contextableai/openclaw-memory-graphiti
```

Then restart the gateway. On first start, the plugin automatically:
- Writes the SpiceDB authorization schema (if not already present)
- Creates group membership for the configured agent in the default group

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- An [OpenAI API key](https://platform.openai.com/api-keys) (Graphiti uses OpenAI for entity extraction and embeddings)

### 1. Start Infrastructure

```bash
cd docker
cp .env.example .env
# Edit .env — set OPENAI_API_KEY at minimum
docker compose up -d falkordb graphiti-mcp postgres spicedb-migrate spicedb
```

This starts:
- **FalkorDB** on port 6379 (graph database, web UI on port 3000)
- **Graphiti MCP Server** on port 8000 (knowledge graph API)
- **PostgreSQL** on port 5432 (persistent datastore for SpiceDB)
- **SpiceDB** on port 50051 (authorization engine)

### 2. Restart the Gateway

```bash
openclaw gateway restart
```

The plugin auto-initializes on startup — no manual `schema-write` or `add-member` needed for basic use. The SpiceDB schema is written automatically on first run, and the configured `subjectId` is added to the `defaultGroupId`.

### 3. (Optional) Add More Group Members

```bash
# Add people to groups
openclaw graphiti-mem add-member family mom --type person
openclaw graphiti-mem add-member family dad --type person
```

## Tools

The plugin registers four tools available to the agent:

### memory_recall

Search memories using the knowledge graph. Returns entities and facts the current subject is authorized to see.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query |
| `limit` | number | 10 | Max results |
| `scope` | string | `"all"` | `"session"`, `"long-term"`, or `"all"` |

Searches both **nodes** (entities) and **facts** (relationships) across all authorized groups in parallel, then deduplicates and ranks by recency.

### memory_store

Save information to the knowledge graph. Graphiti automatically extracts entities and facts from the content.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | *required* | Information to remember |
| `source_description` | string | `"conversation"` | Context about the source |
| `involves` | string[] | `[]` | Person/agent IDs involved |
| `group_id` | string | configured default | Target group for this memory |
| `longTerm` | boolean | `true` | `false` stores to the current session group |

Write authorization is enforced before storing:
- **Own session groups** auto-create membership (the agent inherits exclusive access)
- **All other groups** require `contribute` permission in SpiceDB

### memory_forget

Delete a memory episode. Requires `delete` permission (only the subject who stored the memory can delete it).

| Parameter | Type | Description |
|-----------|------|-------------|
| `episode_id` | string | Episode UUID to delete |

### memory_status

Check the health of Graphiti and SpiceDB services. No parameters.

## Automatic Behaviors

### Auto-Recall

When enabled (default: `true`), the plugin searches relevant memories before each agent turn and injects them into the conversation context as `<relevant-memories>` blocks.

- Searches up to 5 long-term memories and 3 session memories per turn
- Deduplicates session results against long-term results
- Only triggers when the user prompt is at least 5 characters

### Auto-Capture

When enabled (default: `true`), the plugin captures the last N messages from each completed agent turn and stores them as a batch episode in Graphiti.

- Captures up to `maxCaptureMessages` messages (default: 10)
- Stores to the current session group by default
- Skips messages shorter than 5 characters and injected context blocks
- Uses custom extraction instructions for entity/fact extraction

## Authorization Model

The SpiceDB schema defines four object types:

```
person {}

agent {
    relation owner: person
    permission act_as = owner
}

group {
    relation member: person | agent
    permission access = member
    permission contribute = member
}

memory_fragment {
    relation source_group: group
    relation involves: person | agent
    relation shared_by: person | agent

    permission view = involves + shared_by + source_group->access
    permission delete = shared_by
}
```

### Groups

Groups organize memories and control access. A subject must be a **member** of a group to read (`access`) or write (`contribute`) to it.

Membership is managed via the CLI (`graphiti-mem add-member`) or programmatically via `ensureGroupMembership()`.

### Memory Fragments

Each stored memory creates a `memory_fragment` with three relationships:
- **source_group** — which group the memory belongs to
- **shared_by** — who stored the memory (can delete it)
- **involves** — people/agents mentioned in the memory (can view it)

View permission is granted to anyone who is directly involved, shared the memory, or has access to the source group. Delete permission is restricted to the subject who shared (stored) the memory.

### Session Groups

Session groups (`session-<id>`) provide per-conversation memory isolation:
- The agent that creates a session automatically gets exclusive membership
- Other agents cannot read or write to foreign session groups without explicit membership
- Session memories are searchable within the session scope and are deduplicated against long-term memories

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `spicedb.endpoint` | string | `localhost:50051` | SpiceDB gRPC endpoint |
| `spicedb.token` | string | *required* | SpiceDB pre-shared key (supports `${ENV_VAR}`) |
| `spicedb.insecure` | boolean | `true` | Allow insecure gRPC (for localhost dev) |
| `graphiti.endpoint` | string | `http://localhost:8000` | Graphiti MCP server URL |
| `graphiti.defaultGroupId` | string | `main` | Default group for memory storage |
| `subjectType` | string | `agent` | SpiceDB subject type (`agent` or `person`) |
| `subjectId` | string | `default` | SpiceDB subject ID (supports `${ENV_VAR}`) |
| `autoCapture` | boolean | `true` | Auto-capture conversations |
| `autoRecall` | boolean | `true` | Auto-inject relevant memories |
| `customInstructions` | string | *(see below)* | Custom extraction instructions for Graphiti |
| `maxCaptureMessages` | integer | `10` | Max messages per auto-capture batch (1-50) |

### Default Custom Instructions

When not overridden, the plugin uses these extraction instructions:

```
Extract key facts about:
- Identity: names, roles, titles, contact info
- Preferences: likes, dislikes, preferred tools/methods
- Goals: objectives, plans, deadlines
- Relationships: connections between people, teams, organizations
- Decisions: choices made, reasoning, outcomes
- Routines: habits, schedules, recurring patterns
Do not extract: greetings, filler, meta-commentary about the conversation itself.
```

### Environment Variable Interpolation

String values in the config support `${ENV_VAR}` syntax:

```json
{
  "spicedb": {
    "token": "${SPICEDB_TOKEN}"
  },
  "subjectId": "${OPENCLAW_AGENT_ID}"
}
```

## CLI Commands

All commands are under `graphiti-mem`:

| Command | Description |
|---------|-------------|
| `graphiti-mem search <query>` | Search memories with authorization. Options: `--limit`, `--scope` |
| `graphiti-mem episodes` | List recent episodes. Options: `--last`, `--group` |
| `graphiti-mem status` | Check SpiceDB + Graphiti connectivity |
| `graphiti-mem schema-write` | Write/update the SpiceDB authorization schema |
| `graphiti-mem groups` | List authorized groups for the current subject |
| `graphiti-mem add-member <group-id> <subject-id>` | Add a subject to a group. Options: `--type` |
| `graphiti-mem import` | Import workspace markdown files into Graphiti. Options: `--workspace`, `--include-sessions`, `--session-dir`, `--group`, `--dry-run` |

## Docker Compose

The `docker/` directory contains a full-stack Docker Compose configuration:

| Service | Port | Description |
|---------|------|-------------|
| `falkordb` | 6379, 3000 | Graph database (Redis protocol) + web UI |
| `graphiti-mcp` | 8000 | Graphiti MCP server (HTTP/SSE) |
| `postgres` | 5432 | Persistent datastore for SpiceDB |
| `spicedb-migrate` | — | One-shot: runs SpiceDB DB migrations |
| `spicedb` | 50051, 8443, 9090 | Authorization engine (gRPC, HTTP, metrics) |
| `openclaw-gateway` | 18789, 18790 | OpenClaw gateway (optional) |

### Infrastructure Only

```bash
docker compose up -d falkordb graphiti-mcp postgres spicedb-migrate spicedb
```

### Full Stack (Gateway + Infrastructure)

```bash
docker compose up -d
```

When running inside Docker Compose, use service hostnames in the plugin config:

```json
{
  "spicedb": {
    "endpoint": "spicedb:50051",
    "token": "${SPICEDB_TOKEN}"
  },
  "graphiti": {
    "endpoint": "http://graphiti-mcp:8000"
  }
}
```

## OpenClaw Integration

### Selecting the Memory Slot

OpenClaw has an exclusive `memory` slot — only one memory plugin is active at a time. To use memory-graphiti, set the slot in your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-graphiti"
    },
    "entries": {
      "memory-graphiti": {
        "enabled": true,
        "config": {
          "spicedb": {
            "endpoint": "localhost:50051",
            "token": "dev_token",
            "insecure": true
          },
          "graphiti": {
            "endpoint": "http://localhost:8000",
            "defaultGroupId": "main"
          },
          "subjectType": "agent",
          "subjectId": "my-agent",
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

The plugin must be discoverable — either symlinked into `extensions/memory-graphiti` in the OpenClaw installation, or loaded via `plugins.load.paths`.

### Initialization

After starting infrastructure, write the SpiceDB schema and create group membership:

```bash
openclaw graphiti-mem schema-write
openclaw graphiti-mem add-member main my-agent --type agent
```

The plugin's startup service also auto-creates membership for the configured `subjectId` in the `defaultGroupId`.

### Migrating from an Existing Memory Plugin

The `import` command migrates workspace markdown files (the universal memory format across all OpenClaw memory plugins) into the Graphiti knowledge graph:

```bash
# Preview what will be imported
openclaw graphiti-mem import --dry-run

# Import workspace files (USER.md, MEMORY.md, memory/*.md, etc.)
openclaw graphiti-mem import

# Also import session transcripts
openclaw graphiti-mem import --include-sessions
```

Workspace files are imported to the configured `defaultGroupId`. Session transcripts are imported to per-session groups (`session-<id>`).

### Session Logging

OpenClaw's JSONL session logging is always-on core behavior — memory-graphiti does not replace it. The plugin augments session context by:

- **Auto-capture**: Extracting entities and facts from conversation turns into the knowledge graph (`agent_end` hook)
- **Auto-recall**: Injecting relevant memories into the agent's context before each turn (`before_agent_start` hook)

The JSONL transcripts remain on disk as a historical record. If you switch back to another memory plugin, they're still available.

## Development

### Dev Scripts

Helper scripts for local development without Docker:

```bash
scripts/dev-setup.sh    # One-time setup: install FalkorDB, Graphiti, SpiceDB
scripts/dev-start.sh    # Start all services with health checks
scripts/dev-stop.sh     # Stop all services
scripts/dev-status.sh   # Check service status
```

### Running Tests

```bash
# Unit tests (80 tests, no running services required)
npm test

# E2E tests (13 tests, requires running infrastructure)
OPENCLAW_LIVE_TEST=1 npm run test:e2e
```

### Project Structure

```
├── index.ts                  # Plugin entry: tools, hooks, CLI, service
├── config.ts                 # Config schema and validation
├── graphiti.ts               # Graphiti MCP HTTP client (JSON-RPC/SSE)
├── spicedb.ts                # SpiceDB gRPC client wrapper
├── authorization.ts          # Authorization logic (SpiceDB operations)
├── search.ts                 # Multi-group parallel search, dedup, formatting
├── schema.zed                # SpiceDB authorization schema
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── docker/
│   ├── docker-compose.yml    # Full infrastructure stack
│   └── .env.example          # Environment variable template
├── scripts/
│   ├── dev-setup.sh          # One-time dev setup
│   ├── dev-start.sh          # Start dev services
│   ├── dev-stop.sh           # Stop dev services
│   └── dev-status.sh         # Check service status
├── index.test.ts             # Plugin integration tests
├── authorization.test.ts     # Authorization unit tests
├── search.test.ts            # Search unit tests
├── graphiti.test.ts          # Graphiti client tests
├── config.test.ts            # Config parsing tests
└── e2e.test.ts               # End-to-end tests (live services)
```
