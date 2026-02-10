/**
 * Graphiti MCP Server HTTP Client
 *
 * Communicates with the Graphiti MCP server via the MCP Streamable HTTP
 * transport (JSON-RPC 2.0 over SSE). Handles session initialization,
 * session ID tracking, and SSE response parsing.
 *
 * Wraps core tools: add_memory, search_nodes, search_memory_facts,
 * get_episodes, delete_episode, get_status.
 */

import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export type GraphitiEpisode = {
  uuid: string;
  name: string;
  content: string;
  source_description: string;
  group_id: string;
  created_at: string;
};

export type GraphitiNode = {
  uuid: string;
  name: string;
  summary: string | null;
  group_id: string;
  labels: string[];
  created_at: string | null;
  attributes: Record<string, unknown>;
};

export type GraphitiFact = {
  uuid: string;
  fact: string;
  name?: string;
  source_node_uuid?: string;
  target_node_uuid?: string;
  source_node_name?: string;
  target_node_name?: string;
  group_id: string;
  created_at: string;
  [key: string]: unknown;
};

export type AddEpisodeResult = {
  episode_uuid: string;
  /** Resolves to the real server-side UUID once Graphiti finishes processing. */
  resolvedUuid: Promise<string>;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ============================================================================
// Client
// ============================================================================

export class GraphitiClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  /** Polling interval (ms) for UUID resolution after addEpisode. */
  uuidPollIntervalMs = 2000;
  /** Max polling attempts for UUID resolution (total wait = interval * attempts). */
  uuidPollMaxAttempts = 15;

  constructor(private readonly endpoint: string) {}

  // --------------------------------------------------------------------------
  // MCP Session Lifecycle
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.sessionId) return;
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "openclaw-memory-graphiti", version: "1.0.0" },
      },
    };

    const response = await fetch(`${this.endpoint}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      this.initPromise = null;
      throw new Error(`Graphiti MCP init failed: ${response.status} ${response.statusText}`);
    }

    // Capture session ID from response header
    this.sessionId = response.headers.get("mcp-session-id");

    // Consume the SSE response body
    await this.parseSseResponse(response);

    // Send notifications/initialized (required by MCP protocol)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    await fetch(`${this.endpoint}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      try {
        await fetch(`${this.endpoint}/mcp`, {
          method: "DELETE",
          headers: { "mcp-session-id": this.sessionId },
        });
      } catch {
        // Ignore cleanup errors
      }
      this.sessionId = null;
      this.initPromise = null;
    }
  }

  // --------------------------------------------------------------------------
  // JSON-RPC / SSE Transport
  // --------------------------------------------------------------------------

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureInitialized();

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(`${this.endpoint}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Graphiti MCP server error: ${response.status} ${response.statusText}`);
    }

    const json = await this.parseResponse(response);

    if (json.error) {
      throw new Error(`Graphiti tool ${name} failed: ${json.error.message}`);
    }

    return json.result;
  }

  private async parseResponse(response: Response): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.parseSseResponse(response);
    }
    return (await response.json()) as JsonRpcResponse;
  }

  private async parseSseResponse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data) {
          return JSON.parse(data) as JsonRpcResponse;
        }
      }
    }
    throw new Error("No JSON-RPC message found in SSE response");
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<unknown> {
    return this.callTool("get_status");
  }

  // --------------------------------------------------------------------------
  // Episodes
  // --------------------------------------------------------------------------

  async addEpisode(params: {
    name: string;
    episode_body: string;
    source_description?: string;
    group_id?: string;
    source?: string;
    /**
     * Custom extraction instructions for Graphiti's LLM entity extraction.
     * The MCP server doesn't expose this parameter, so we prepend the
     * instructions to episode_body with clear delimiters. Graphiti's
     * extraction prompts include the full episode content, so the LLM
     * will see these instructions inline alongside the actual content.
     */
    custom_extraction_instructions?: string;
    /** @deprecated The MCP server's uuid param is for re-processing existing episodes */
    uuid?: string;
    /** @deprecated No longer supported by the Graphiti MCP server */
    reference_time?: string;
  }): Promise<AddEpisodeResult> {
    // Note: The Graphiti MCP server's uuid parameter is for re-processing
    // existing episodes, NOT for setting the UUID of new ones. We generate
    // a client-side tracking UUID instead (it won't match the server-side UUID).
    const trackingUuid = randomUUID();

    // Prepend custom extraction instructions to episode_body since the MCP
    // server doesn't support custom_extraction_instructions as a parameter.
    // The extraction LLM sees the full episode content, so inline instructions work.
    let effectiveBody = params.episode_body;
    if (params.custom_extraction_instructions) {
      effectiveBody =
        `[Extraction Instructions]\n${params.custom_extraction_instructions}\n[End Instructions]\n\n${params.episode_body}`;
    }

    const args: Record<string, unknown> = {
      name: params.name,
      episode_body: effectiveBody,
    };
    if (params.group_id) {
      args.group_id = params.group_id;
    }
    if (params.source) {
      args.source = params.source;
    }
    if (params.source_description) {
      args.source_description = params.source_description;
    }

    await this.callTool("add_memory", args);

    // Graphiti's add_memory queues the episode for async LLM processing and
    // returns only a "queued" message — no UUID. We poll getEpisodes in the
    // background to discover the real server-side UUID by name match.
    let resolvedUuid: Promise<string>;
    if (params.group_id) {
      resolvedUuid = this.resolveEpisodeUuid(params.name, params.group_id);
      resolvedUuid.catch(() => {}); // Prevent unhandled rejection if caller ignores
    } else {
      resolvedUuid = Promise.resolve(trackingUuid);
    }

    return { episode_uuid: trackingUuid, resolvedUuid };
  }

  private async resolveEpisodeUuid(name: string, groupId: string): Promise<string> {
    for (let i = 0; i < this.uuidPollMaxAttempts; i++) {
      await new Promise((r) => setTimeout(r, this.uuidPollIntervalMs));
      try {
        const episodes = await this.getEpisodes(groupId, 50);
        const match = episodes.find((ep) => ep.name === name);
        if (match) return match.uuid;
      } catch {
        // Retry on transient errors
      }
    }
    throw new Error(
      `Failed to resolve episode UUID for "${name}" in group "${groupId}" after ${(this.uuidPollMaxAttempts * this.uuidPollIntervalMs) / 1000}s`,
    );
  }

  async getEpisodes(groupId: string, lastN: number): Promise<GraphitiEpisode[]> {
    const result = await this.callTool("get_episodes", {
      group_ids: [groupId],
      max_episodes: lastN,
    });
    return parseToolResult<GraphitiEpisode[]>(result, "episodes");
  }

  async deleteEpisode(episodeUuid: string): Promise<void> {
    await this.callTool("delete_episode", { uuid: episodeUuid });
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  async searchNodes(params: {
    query: string;
    group_id?: string;
    group_ids?: string[];
    limit?: number;
  }): Promise<GraphitiNode[]> {
    const args: Record<string, unknown> = {
      query: params.query,
    };
    const groupIds = params.group_ids ?? (params.group_id ? [params.group_id] : undefined);
    if (groupIds) {
      args.group_ids = groupIds;
    }
    if (params.limit !== undefined) {
      args.max_nodes = params.limit;
    }

    const result = await this.callTool("search_nodes", args);
    return parseToolResult<GraphitiNode[]>(result, "nodes");
  }

  async searchFacts(params: {
    query: string;
    group_id?: string;
    group_ids?: string[];
    limit?: number;
    /** @deprecated No longer supported by the Graphiti MCP server */
    created_after?: string;
  }): Promise<GraphitiFact[]> {
    const args: Record<string, unknown> = {
      query: params.query,
    };
    const groupIds = params.group_ids ?? (params.group_id ? [params.group_id] : undefined);
    if (groupIds) {
      args.group_ids = groupIds;
    }
    if (params.limit !== undefined) {
      args.max_facts = params.limit;
    }

    const result = await this.callTool("search_memory_facts", args);
    return parseToolResult<GraphitiFact[]>(result, "facts");
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract a typed result from an MCP tool response.
 * The response is typically wrapped in content blocks:
 *   { content: [{ type: "text", text: "{ \"nodes\": [...] }" }] }
 * This function unwraps the content block, parses the JSON, and extracts
 * the named field (e.g. "nodes", "facts", "episodes").
 */
function parseToolResult<T>(result: unknown, key: string): T {
  const parsed = parseJsonResult<Record<string, unknown>>(result);
  if (parsed && typeof parsed === "object" && key in parsed) {
    return parsed[key] as T;
  }
  return [] as unknown as T;
}

function parseJsonResult<T>(result: unknown): T {
  if (typeof result === "string") {
    return JSON.parse(result) as T;
  }
  // MCP tool results are typically wrapped in content blocks
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (first.type === "text" && typeof first.text === "string") {
        return JSON.parse(first.text) as T;
      }
    }
  }
  return result as T;
}
