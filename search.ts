/**
 * Parallel Multi-Group Search + Merge/Re-rank
 *
 * Issues parallel search calls to Graphiti (one per authorized group_id),
 * merges results, deduplicates, and re-ranks.
 */

import type { GraphitiClient, GraphitiNode, GraphitiFact } from "./graphiti.js";

// ============================================================================
// Types
// ============================================================================

export type SearchResult = {
  type: "node" | "fact";
  uuid: string;
  group_id: string;
  summary: string;
  /** Additional context: entity names for facts, node name for nodes */
  context: string;
  created_at: string;
};

export type SearchOptions = {
  query: string;
  groupIds: string[];
  limit?: number;
  searchNodes?: boolean;
  searchFacts?: boolean;
};

// ============================================================================
// Search
// ============================================================================

/**
 * Search across multiple authorized group_ids in parallel.
 * Merges and deduplicates results, returning up to `limit` items.
 */
export async function searchAuthorizedMemories(
  graphiti: GraphitiClient,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { query, groupIds, limit = 10, searchNodes = true, searchFacts = true } = options;

  if (groupIds.length === 0) {
    return [];
  }

  // Fan out parallel searches: for each group_id, search nodes and/or facts
  const promises: Promise<SearchResult[]>[] = [];

  for (const groupId of groupIds) {
    if (searchNodes) {
      promises.push(searchNodesForGroup(graphiti, query, groupId, limit));
    }
    if (searchFacts) {
      promises.push(searchFactsForGroup(graphiti, query, groupId, limit));
    }
  }

  const resultSets = await Promise.allSettled(promises);

  // Collect all successful results
  const allResults: SearchResult[] = [];
  for (const result of resultSets) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
    // Silently skip failed group searches — partial results are better than none
  }

  // Deduplicate by UUID
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    if (seen.has(r.uuid)) {
      return false;
    }
    seen.add(r.uuid);
    return true;
  });

  // Sort by recency (most recent first) and trim to limit
  deduped.sort((a, b) => {
    const dateA = new Date(a.created_at).getTime();
    const dateB = new Date(b.created_at).getTime();
    return dateB - dateA;
  });

  return deduped.slice(0, limit);
}

// ============================================================================
// Per-group search helpers
// ============================================================================

async function searchNodesForGroup(
  graphiti: GraphitiClient,
  query: string,
  groupId: string,
  limit: number,
): Promise<SearchResult[]> {
  const nodes = await graphiti.searchNodes({ query, group_id: groupId, limit });
  return nodes.map(nodeToResult);
}

async function searchFactsForGroup(
  graphiti: GraphitiClient,
  query: string,
  groupId: string,
  limit: number,
): Promise<SearchResult[]> {
  const facts = await graphiti.searchFacts({ query, group_id: groupId, limit });
  return facts.map(factToResult);
}

function nodeToResult(node: GraphitiNode): SearchResult {
  return {
    type: "node",
    uuid: node.uuid,
    group_id: node.group_id,
    summary: node.summary ?? node.name,
    context: node.name,
    created_at: node.created_at ?? new Date().toISOString(),
  };
}

function factToResult(fact: GraphitiFact): SearchResult {
  // Use node names if available, fall back to relationship name or UUIDs
  const source = fact.source_node_name ?? fact.source_node_uuid ?? "?";
  const target = fact.target_node_name ?? fact.target_node_uuid ?? "?";
  const context = fact.name ? `${source} -[${fact.name}]→ ${target}` : `${source} → ${target}`;
  return {
    type: "fact",
    uuid: fact.uuid,
    group_id: fact.group_id,
    summary: fact.fact,
    context,
    created_at: fact.created_at,
  };
}

// ============================================================================
// Format for agent context
// ============================================================================

/**
 * Format search results into a text block suitable for injecting into agent context.
 */
export function formatResultsForContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return "";
  }

  return results
    .map((r, i) => {
      const typeLabel = r.type === "node" ? "entity" : "fact";
      return `${i + 1}. [${typeLabel}] ${r.summary} (${r.context})`;
    })
    .join("\n");
}

/**
 * Format results with session and long-term sections separated.
 * Session group_ids start with "session/".
 */
export function formatDualResults(
  longTermResults: SearchResult[],
  sessionResults: SearchResult[],
): string {
  const parts: string[] = [];
  let idx = 1;

  if (longTermResults.length > 0) {
    for (const r of longTermResults) {
      const typeLabel = r.type === "node" ? "entity" : "fact";
      parts.push(`${idx++}. [${typeLabel}] ${r.summary} (${r.context})`);
    }
  }

  if (sessionResults.length > 0) {
    parts.push("Session memories:");
    for (const r of sessionResults) {
      const typeLabel = r.type === "node" ? "entity" : "fact";
      parts.push(`${idx++}. [${typeLabel}] ${r.summary} (${r.context})`);
    }
  }

  return parts.join("\n");
}

/**
 * Deduplicate session results against long-term results (by UUID).
 */
export function deduplicateSessionResults(
  longTermResults: SearchResult[],
  sessionResults: SearchResult[],
): SearchResult[] {
  const longTermIds = new Set(longTermResults.map((r) => r.uuid));
  return sessionResults.filter((r) => !longTermIds.has(r.uuid));
}
