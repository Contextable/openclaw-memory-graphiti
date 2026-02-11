# CLAUDE.md — @contextableai/openclaw-memory-graphiti

## Project Overview

OpenClaw memory plugin with a two-layer architecture:
- **SpiceDB** — relationship-based access control (ReBAC). Determines who can read/write/delete which memories.
- **Graphiti** — knowledge graph (via MCP server over HTTP/SSE). Stores episodes, entities, and facts.

Authorization is enforced at the data layer, not in prompts. Every read, write, and delete goes through SpiceDB before touching Graphiti.

## Quick Reference

```bash
# Run unit tests (no services required)
npx vitest run --exclude e2e.test.ts

# Run e2e tests (13 tests, requires running services)
# Use OPENAI_API_KEY=1 as dummy value — Graphiti needs it set but the test doesn't call OpenAI directly
OPENAI_API_KEY=1 OPENCLAW_LIVE_TEST=1 npx vitest run e2e.test.ts

# Start infrastructure natively (dev container)
./scripts/dev-start.sh

# Start infrastructure via Docker Compose (production)
cd docker && docker compose up -d

# Import existing OpenClaw workspace memories into Graphiti
openclaw graphiti-mem import --dry-run   # preview
openclaw graphiti-mem import             # workspace files
openclaw graphiti-mem import --include-sessions  # + session transcripts

# Standalone CLI (no OpenClaw gateway required)
SPICEDB_TOKEN=dev_token npm run cli -- status
SPICEDB_TOKEN=dev_token npx tsx bin/graphiti-mem.ts search "some query"
```

## File Layout

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Registers tools (`memory_recall`, `memory_store`, `memory_forget`, `memory_status`), lifecycle hooks (`before_agent_start` for auto-recall, `agent_end` for auto-capture), CLI commands (via `cli.ts`), and the startup service. |
| `cli.ts` | Shared CLI command registration (`registerCommands()`). Used by both the plugin (`index.ts`) and the standalone entry point (`bin/graphiti-mem.ts`). |
| `bin/graphiti-mem.ts` | Standalone CLI entry point. Loads config from env vars / JSON file, instantiates clients, delegates to `registerCommands()`. |
| `config.ts` | Config schema, parsing, defaults, `${ENV_VAR}` interpolation. |
| `graphiti.ts` | `GraphitiClient` — HTTP client for Graphiti MCP server. JSON-RPC 2.0 over SSE with MCP session lifecycle (initialize → tools/call → close). |
| `spicedb.ts` | `SpiceDbClient` — gRPC wrapper around `@authzed/authzed-node`. WriteSchema, ReadSchema, WriteRelationships, DeleteRelationships, DeleteRelationshipsByFilter, BulkImportRelationships, CheckPermission, LookupResources. All reads accept a `ConsistencyMode` parameter; all writes return a ZedToken string. |
| `authorization.ts` | Authorization operations that bridge SpiceDB and the plugin: `lookupAuthorizedGroups`, `lookupViewableFragments`, `writeFragmentRelationships`, `deleteFragmentRelationships`, `canDeleteFragment`, `canWriteToGroup`, `ensureGroupMembership`. |
| `search.ts` | Parallel multi-group search. Fans out to Graphiti (nodes + facts per group), deduplicates by UUID, ranks by recency. Also handles session vs long-term formatting. |
| `schema.zed` | SpiceDB authorization schema (Zanzibar-style). Defines `person`, `agent`, `group`, `memory_fragment` with permissions. |
| `openclaw.plugin.json` | Plugin manifest with `configSchema` and `uiHints`. |

## Architecture Decisions

### Authorization Flow

Every tool follows the same pattern:
1. Check SpiceDB permission (read: `lookupResources`, write: `checkPermission`, delete: `checkPermission`)
2. If denied, return early — never touch Graphiti
3. If allowed, perform the Graphiti operation
4. After Graphiti writes, record the authorization relationships in SpiceDB

### ZedToken Consistency

SpiceDB writes return a `ZedToken` — a causality token that guarantees subsequent reads see at least the state at the time of that write.

The plugin maintains a `lastWriteToken: string | undefined` variable in `index.ts`. After any SpiceDB write (`writeRelationships`, `deleteRelationships`, `ensureGroupMembership`, `writeFragmentRelationships`, `deleteFragmentRelationships`), the token is captured. Before any SpiceDB read (`lookupAuthorizedGroups`, `canWriteToGroup`, `canDeleteFragment`), the token is passed as `atLeastAsFresh` consistency. If no prior write exists, reads use `minimizeLatency` (cheapest mode).

This replaces the original `fullyConsistent` mode on all reads, which was correct but expensive (forces a quorum read). The `atLeastAsFresh` mode gives causal consistency at near-zero cost.

The three consistency modes in `SpiceDbClient`:
- `minimize_latency` — default, cheapest, may return stale data
- `at_least_as_fresh` — causal, uses a ZedToken from a prior write
- `full` — quorum read, most expensive, always up-to-date

**E2e test pitfall**: The e2e tests also thread `lastWriteToken` through their SpiceDB calls. Without this, `lookupAuthorizedGroups` after `ensureGroupMembership` in `beforeAll` can return stale results.

### Fragment Deletion

`deleteFragmentRelationships` uses the filter-based `DeleteRelationships` RPC (not the tuple-based `WriteRelationships` with DELETE ops). This deletes ALL relationships where the fragment is the resource, regardless of which group it was stored to or who shared it. This is important because the caller may not know the original group or subject.

### Bulk Import

`bulkImportRelationships` uses the client-streaming `BulkImportRelationships` gRPC RPC. The `@authzed/authzed-node` library exposes this as a callback-based API (not promisified), so `SpiceDbClient` wraps it in a manual Promise. Falls back to batched `writeRelationships` calls if the streaming RPC is unavailable.

The `graphiti-mem import` CLI uses a two-phase approach:
1. **Phase 1**: Ingest all files/sessions to Graphiti via `addEpisode`, collecting relationship tuples
2. **Phase 2**: Single `bulkImportRelationships` call for all collected tuples

This is faster than interleaving and leaves SpiceDB clean if Graphiti fails partway (orphaned episodes are invisible without authorization — see issue #6 for cleanup tooling).

### Session Groups

Session groups use the format `session-<sessionId>` (dash separator — Graphiti `group_id` only allows alphanumeric, dashes, underscores).

**Own session** (agent's current session): Membership is auto-created via `ensureGroupMembership()`. No pre-check needed — the agent owns the session.

**Foreign session** (any other session group): Requires explicit `contribute` permission, same as non-session groups. This prevents cross-agent session memory injection.

The check in `index.ts` is:
```typescript
const isOwnSession =
  isSessionGroup(targetGroupId) &&
  currentSessionId != null &&
  targetGroupId === sessionGroupId(currentSessionId);
```

### SpiceDB Schema (schema.zed)

```
group:
  member → person | agent
  access = member        (read-side gate)
  contribute = member    (write-side gate)

memory_fragment:
  source_group → group
  involves → person | agent
  shared_by → person | agent
  view = involves + shared_by + source_group->access
  delete = shared_by
```

`access` and `contribute` both resolve to `member` today but are separate permissions so they can diverge later (e.g., adding a `reader` relation).

### Graphiti Communication

The `GraphitiClient` speaks MCP Streamable HTTP transport: JSON-RPC 2.0 requests, responses come back as SSE (`text/event-stream`) or plain JSON. The client handles:
- Session initialization (`initialize` → `notifications/initialized`)
- Session ID tracking via `mcp-session-id` header
- SSE response parsing (extracts `data:` lines)
- Content block unwrapping (MCP tool results are wrapped in `{ content: [{ type: "text", text: "..." }] }`)

Custom extraction instructions are prepended to `episode_body` with `[Extraction Instructions]`/`[End Instructions]` delimiters since the Graphiti MCP server doesn't expose a `custom_extraction_instructions` parameter.

## Testing

### Unit Tests (85 tests, 5 files)

All unit tests mock external dependencies — no running services needed.

- `index.test.ts` (19 tests) — Plugin integration: tool execution, hooks, CLI, authorization enforcement, ZedToken threading. Mocks both `@authzed/authzed-node` (via `vi.mock`) and `fetch` (for Graphiti MCP).
- `authorization.test.ts` (14 tests) — Authorization functions with mocked SpiceDB client. Includes consistency mode verification.
- `search.test.ts` (16 tests) — Parallel search, dedup, formatting with mocked Graphiti client.
- `graphiti.test.ts` (21 tests) — Graphiti MCP client with mocked fetch (SSE parsing, session handling).
- `config.test.ts` (15 tests) — Config parsing, defaults, env var resolution, validation.

### E2E Tests (13 tests, 1 file)

`e2e.test.ts` runs against real SpiceDB + Graphiti + FalkorDB. Requires:
- Services running natively (dev container) or via Docker
- `OPENAI_API_KEY` in environment (can be dummy `1` value for test runner — Graphiti needs it set)
- `OPENCLAW_LIVE_TEST=1` to enable

Tests are skipped automatically when `OPENCLAW_LIVE_TEST` is not set.

**Important**: Run e2e tests from the plugin directory, not the parent workspace. Running from the parent will pick up all `*.test.ts` files across workspaces.

The dev container SpiceDB token is `dev_token` (configured in OpenClaw plugin config). The e2e tests use `testtoken` (hardcoded in `e2e.test.ts`).

### Test Pitfalls

**Mock leaking in `index.test.ts`**: The `@authzed/authzed-node` mock is created via `vi.mock()` at the module level. `vi.restoreAllMocks()` does NOT reset `vi.fn()` instances created inside `vi.mock()` callbacks. Tests that modify `checkPermission` or `lookupResources` behavior must be followed by an explicit reset in `beforeEach`:

```typescript
beforeEach(async () => {
  vi.restoreAllMocks();
  // Must also reset the mocks inside vi.mock() callback:
  const { v1 } = await import("@authzed/authzed-node");
  const mockClient = (v1.NewClient as ReturnType<typeof vi.fn>)();
  mockClient.promises.checkPermission.mockResolvedValue({ permissionship: 2 });
  mockClient.promises.lookupResources.mockResolvedValue([{ resourceObjectId: "main" }]);
  mockClient.promises.writeRelationships.mockResolvedValue({ writtenAt: { token: "write-token-1" } });
  mockClient.promises.deleteRelationships.mockResolvedValue({ deletedAt: { token: "delete-token" } });
});
```

**Graphiti MCP mock in `index.test.ts`**: The plugin uses `fetch` for Graphiti communication (MCP Streamable HTTP). Tests mock `globalThis.fetch` and must handle the full MCP handshake: `initialize` (SSE response with `mcp-session-id`), `notifications/initialized` (202), and tool calls (SSE-wrapped JSON-RPC results). The helper `setupGraphitiMock()` configures this.

## Config Defaults

| Key | Default |
|-----|---------|
| `spicedb.endpoint` | `localhost:50051` |
| `spicedb.insecure` | `true` |
| `graphiti.endpoint` | `http://localhost:8000` |
| `graphiti.defaultGroupId` | `main` |
| `subjectType` | `agent` |
| `subjectId` | `default` |
| `autoCapture` | `true` |
| `autoRecall` | `true` |
| `maxCaptureMessages` | `10` |

`spicedb.token` is the only required config field.

## Conventions

- TypeScript ESM (`"type": "module"` in package.json). All local imports use `.js` extension.
- Target: ES2023, Node.js module resolution (`NodeNext`).
- No build step — OpenClaw loads `.ts` files directly.
- Strict TypeScript (`"strict": true`).
- Tests use Vitest. Test files are co-located with source (`*.test.ts`).
- Dependencies: `@authzed/authzed-node` v1.6.1 (SpiceDB gRPC), `@sinclair/typebox` (tool parameter schemas).
- When exploring `@authzed/authzed-node` APIs, use DeepWiki MCP (`ask_question` on `authzed/authzed-node`) or check the library's own tests at `node_modules/@authzed/authzed-node/src/v1-promise.test.ts` for usage patterns. Some streaming RPCs (like `bulkImportRelationships`) are callback-based, not promisified.
- The `openclaw/plugin-sdk` import is resolved from the parent monorepo (or via `OPENCLAW_ROOT` env var for standalone dev, configured in `vitest.config.ts`).

## The `.dev/` Directory

`.dev/graphiti/` contains an upstream Graphiti Python clone used for local development of the Graphiti MCP server. It is gitignored and not part of this plugin. Do not modify files in `.dev/`.
