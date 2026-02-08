# CLAUDE.md — @openclaw/memory-graphiti

## Project Overview

OpenClaw memory plugin with a two-layer architecture:
- **SpiceDB** — relationship-based access control (ReBAC). Determines who can read/write/delete which memories.
- **Graphiti** — knowledge graph (via MCP server over HTTP/SSE). Stores episodes, entities, and facts.

Authorization is enforced at the data layer, not in prompts. Every read, write, and delete goes through SpiceDB before touching Graphiti.

## Quick Reference

```bash
# Run unit tests (80 tests, no services required)
npx vitest run --exclude e2e.test.ts

# Run e2e tests (13 tests, requires running services)
OPENCLAW_LIVE_TEST=1 npx vitest run e2e.test.ts

# Start infrastructure natively (dev container)
./scripts/dev-start.sh

# Start infrastructure via Docker Compose (production)
cd docker && docker compose up -d

# Import existing OpenClaw workspace memories into Graphiti
openclaw graphiti-mem import --dry-run   # preview
openclaw graphiti-mem import             # workspace files
openclaw graphiti-mem import --include-sessions  # + session transcripts
```

## File Layout

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point. Registers tools (`memory_recall`, `memory_store`, `memory_forget`, `memory_status`), lifecycle hooks (`before_agent_start` for auto-recall, `agent_end` for auto-capture), CLI commands (`graphiti-mem`), and the startup service. |
| `config.ts` | Config schema, parsing, defaults, `${ENV_VAR}` interpolation. |
| `graphiti.ts` | `GraphitiClient` — HTTP client for Graphiti MCP server. JSON-RPC 2.0 over SSE with MCP session lifecycle (initialize → tools/call → close). |
| `spicedb.ts` | `SpiceDbClient` — gRPC wrapper around `@authzed/authzed-node`. WriteSchema, ReadSchema, WriteRelationships, DeleteRelationships, CheckPermission, LookupResources. |
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

### Unit Tests (80 tests, 5 files)

All unit tests mock external dependencies — no running services needed.

- `index.test.ts` (18 tests) — Plugin integration: tool execution, hooks, CLI, authorization enforcement. Mocks both `@authzed/authzed-node` (via `vi.mock`) and `fetch` (for Graphiti MCP).
- `authorization.test.ts` (10 tests) — Authorization functions with mocked SpiceDB client.
- `search.test.ts` (16 tests) — Parallel search, dedup, formatting with mocked Graphiti client.
- `graphiti.test.ts` (21 tests) — Graphiti MCP client with mocked fetch (SSE parsing, session handling).
- `config.test.ts` (15 tests) — Config parsing, defaults, env var resolution, validation.

### E2E Tests (13 tests, 1 file)

`e2e.test.ts` runs against real SpiceDB + Graphiti + FalkorDB. Requires:
- Docker services running (`docker compose up -d falkordb graphiti-mcp spicedb`)
- `OPENAI_API_KEY` in environment
- `OPENCLAW_LIVE_TEST=1` to enable

Tests are skipped automatically when `OPENCLAW_LIVE_TEST` is not set.

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
- Dependencies: `@authzed/authzed-node` (SpiceDB gRPC), `@sinclair/typebox` (tool parameter schemas).
- The `openclaw/plugin-sdk` import is resolved from the parent monorepo (or via `OPENCLAW_ROOT` env var for standalone dev, configured in `vitest.config.ts`).

## The `.dev/` Directory

`.dev/graphiti/` contains an upstream Graphiti Python clone used for local development of the Graphiti MCP server. It is gitignored and not part of this plugin. Do not modify files in `.dev/`.
