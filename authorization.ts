/**
 * Authorization Logic
 *
 * Bridges SpiceDB and Graphiti by managing:
 * - Looking up which group_ids a subject can access
 * - Writing fragment authorization relationships when memories are stored
 * - Checking delete permissions
 */

import type { SpiceDbClient, RelationshipTuple } from "./spicedb.js";

// ============================================================================
// Types
// ============================================================================

export type Subject = {
  type: "agent" | "person";
  id: string;
};

export type FragmentRelationships = {
  fragmentId: string;
  groupId: string;
  sharedBy: Subject;
  involves?: Subject[];
};

// ============================================================================
// Authorization Operations
// ============================================================================

/**
 * Look up all group IDs that a subject has access to.
 * Returns group resource IDs from SpiceDB where the subject has the "access" permission.
 */
export async function lookupAuthorizedGroups(
  spicedb: SpiceDbClient,
  subject: Subject,
): Promise<string[]> {
  return spicedb.lookupResources({
    resourceType: "group",
    permission: "access",
    subjectType: subject.type,
    subjectId: subject.id,
  });
}

/**
 * Look up all memory fragment IDs that a subject can view.
 * Used for fine-grained post-filtering when needed.
 */
export async function lookupViewableFragments(
  spicedb: SpiceDbClient,
  subject: Subject,
): Promise<string[]> {
  return spicedb.lookupResources({
    resourceType: "memory_fragment",
    permission: "view",
    subjectType: subject.type,
    subjectId: subject.id,
  });
}

/**
 * Write authorization relationships for a newly stored memory fragment.
 *
 * Creates:
 * - memory_fragment:<id> #source_group group:<groupId>
 * - memory_fragment:<id> #shared_by <sharedBy>
 * - memory_fragment:<id> #involves <person> (for each involved person)
 */
export async function writeFragmentRelationships(
  spicedb: SpiceDbClient,
  params: FragmentRelationships,
): Promise<void> {
  const tuples: RelationshipTuple[] = [
    {
      resourceType: "memory_fragment",
      resourceId: params.fragmentId,
      relation: "source_group",
      subjectType: "group",
      subjectId: params.groupId,
    },
    {
      resourceType: "memory_fragment",
      resourceId: params.fragmentId,
      relation: "shared_by",
      subjectType: params.sharedBy.type,
      subjectId: params.sharedBy.id,
    },
  ];

  if (params.involves) {
    for (const person of params.involves) {
      tuples.push({
        resourceType: "memory_fragment",
        resourceId: params.fragmentId,
        relation: "involves",
        subjectType: person.type,
        subjectId: person.id,
      });
    }
  }

  await spicedb.writeRelationships(tuples);
}

/**
 * Remove all authorization relationships for a memory fragment.
 * Called when deleting a memory.
 */
export async function deleteFragmentRelationships(
  spicedb: SpiceDbClient,
  fragmentId: string,
  params: FragmentRelationships,
): Promise<void> {
  const tuples: RelationshipTuple[] = [
    {
      resourceType: "memory_fragment",
      resourceId: fragmentId,
      relation: "source_group",
      subjectType: "group",
      subjectId: params.groupId,
    },
    {
      resourceType: "memory_fragment",
      resourceId: fragmentId,
      relation: "shared_by",
      subjectType: params.sharedBy.type,
      subjectId: params.sharedBy.id,
    },
  ];

  if (params.involves) {
    for (const person of params.involves) {
      tuples.push({
        resourceType: "memory_fragment",
        resourceId: fragmentId,
        relation: "involves",
        subjectType: person.type,
        subjectId: person.id,
      });
    }
  }

  await spicedb.deleteRelationships(tuples);
}

/**
 * Check if a subject has delete permission on a memory fragment.
 */
export async function canDeleteFragment(
  spicedb: SpiceDbClient,
  subject: Subject,
  fragmentId: string,
): Promise<boolean> {
  return spicedb.checkPermission({
    resourceType: "memory_fragment",
    resourceId: fragmentId,
    permission: "delete",
    subjectType: subject.type,
    subjectId: subject.id,
  });
}

/**
 * Check if a subject has write (contribute) permission on a group.
 * Used to gate writes to non-session groups — prevents unauthorized memory injection.
 */
export async function canWriteToGroup(
  spicedb: SpiceDbClient,
  subject: Subject,
  groupId: string,
): Promise<boolean> {
  return spicedb.checkPermission({
    resourceType: "group",
    resourceId: groupId,
    permission: "contribute",
    subjectType: subject.type,
    subjectId: subject.id,
  });
}

/**
 * Ensure a subject is registered as a member of a group.
 * Idempotent (uses TOUCH operation).
 */
export async function ensureGroupMembership(
  spicedb: SpiceDbClient,
  groupId: string,
  member: Subject,
): Promise<void> {
  await spicedb.writeRelationships([
    {
      resourceType: "group",
      resourceId: groupId,
      relation: "member",
      subjectType: member.type,
      subjectId: member.id,
    },
  ]);
}
