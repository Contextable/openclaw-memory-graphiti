import { describe, test, expect, vi } from "vitest";
import {
  lookupAuthorizedGroups,
  lookupViewableFragments,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
  ensureGroupMembership,
} from "./authorization.js";
import type { SpiceDbClient } from "./spicedb.js";

function mockSpiceDb(overrides?: Partial<SpiceDbClient>): SpiceDbClient {
  return {
    writeSchema: vi.fn().mockResolvedValue(undefined),
    readSchema: vi.fn().mockResolvedValue(""),
    writeRelationships: vi.fn().mockResolvedValue(undefined),
    deleteRelationships: vi.fn().mockResolvedValue(undefined),
    checkPermission: vi.fn().mockResolvedValue(true),
    lookupResources: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SpiceDbClient;
}

describe("lookupAuthorizedGroups", () => {
  test("queries SpiceDB for groups with access permission", async () => {
    const lookupResources = vi.fn().mockResolvedValue(["family", "work"]);
    const spicedb = mockSpiceDb({ lookupResources });

    const groups = await lookupAuthorizedGroups(spicedb, { type: "agent", id: "pi" });

    expect(lookupResources).toHaveBeenCalledWith({
      resourceType: "group",
      permission: "access",
      subjectType: "agent",
      subjectId: "pi",
    });
    expect(groups).toEqual(["family", "work"]);
  });
});

describe("lookupViewableFragments", () => {
  test("queries SpiceDB for viewable memory_fragments", async () => {
    const lookupResources = vi.fn().mockResolvedValue(["frag-1", "frag-2"]);
    const spicedb = mockSpiceDb({ lookupResources });

    const frags = await lookupViewableFragments(spicedb, { type: "person", id: "mom" });

    expect(lookupResources).toHaveBeenCalledWith({
      resourceType: "memory_fragment",
      permission: "view",
      subjectType: "person",
      subjectId: "mom",
    });
    expect(frags).toEqual(["frag-1", "frag-2"]);
  });
});

describe("writeFragmentRelationships", () => {
  test("writes source_group and shared_by relationships", async () => {
    const writeRelationships = vi.fn().mockResolvedValue(undefined);
    const spicedb = mockSpiceDb({ writeRelationships });

    await writeFragmentRelationships(spicedb, {
      fragmentId: "ep-123",
      groupId: "family",
      sharedBy: { type: "agent", id: "pi" },
    });

    expect(writeRelationships).toHaveBeenCalledTimes(1);
    const tuples = writeRelationships.mock.calls[0][0];
    expect(tuples).toHaveLength(2);
    expect(tuples[0]).toEqual({
      resourceType: "memory_fragment",
      resourceId: "ep-123",
      relation: "source_group",
      subjectType: "group",
      subjectId: "family",
    });
    expect(tuples[1]).toEqual({
      resourceType: "memory_fragment",
      resourceId: "ep-123",
      relation: "shared_by",
      subjectType: "agent",
      subjectId: "pi",
    });
  });

  test("writes involves relationships for each involved person", async () => {
    const writeRelationships = vi.fn().mockResolvedValue(undefined);
    const spicedb = mockSpiceDb({ writeRelationships });

    await writeFragmentRelationships(spicedb, {
      fragmentId: "ep-456",
      groupId: "family",
      sharedBy: { type: "agent", id: "pi" },
      involves: [
        { type: "person", id: "mark" },
        { type: "person", id: "mom" },
      ],
    });

    const tuples = writeRelationships.mock.calls[0][0];
    // source_group + shared_by + 2 involves = 4
    expect(tuples).toHaveLength(4);
    expect(tuples[2]).toEqual({
      resourceType: "memory_fragment",
      resourceId: "ep-456",
      relation: "involves",
      subjectType: "person",
      subjectId: "mark",
    });
    expect(tuples[3]).toEqual({
      resourceType: "memory_fragment",
      resourceId: "ep-456",
      relation: "involves",
      subjectType: "person",
      subjectId: "mom",
    });
  });
});

describe("deleteFragmentRelationships", () => {
  test("deletes matching relationships", async () => {
    const deleteRelationships = vi.fn().mockResolvedValue(undefined);
    const spicedb = mockSpiceDb({ deleteRelationships });

    await deleteFragmentRelationships(spicedb, "ep-123", {
      fragmentId: "ep-123",
      groupId: "family",
      sharedBy: { type: "agent", id: "pi" },
    });

    expect(deleteRelationships).toHaveBeenCalledTimes(1);
    const tuples = deleteRelationships.mock.calls[0][0];
    expect(tuples).toHaveLength(2);
  });
});

describe("canDeleteFragment", () => {
  test("returns true when subject has delete permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(true);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canDeleteFragment(spicedb, { type: "agent", id: "pi" }, "ep-123");

    expect(allowed).toBe(true);
    expect(checkPermission).toHaveBeenCalledWith({
      resourceType: "memory_fragment",
      resourceId: "ep-123",
      permission: "delete",
      subjectType: "agent",
      subjectId: "pi",
    });
  });

  test("returns false when subject lacks delete permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(false);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canDeleteFragment(spicedb, { type: "person", id: "mom" }, "ep-123");
    expect(allowed).toBe(false);
  });
});

describe("canWriteToGroup", () => {
  test("returns true when subject has contribute permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(true);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canWriteToGroup(spicedb, { type: "agent", id: "pi" }, "family");

    expect(allowed).toBe(true);
    expect(checkPermission).toHaveBeenCalledWith({
      resourceType: "group",
      resourceId: "family",
      permission: "contribute",
      subjectType: "agent",
      subjectId: "pi",
    });
  });

  test("returns false when subject lacks contribute permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(false);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canWriteToGroup(spicedb, { type: "person", id: "outsider" }, "family");
    expect(allowed).toBe(false);
  });
});

describe("ensureGroupMembership", () => {
  test("writes group member relationship", async () => {
    const writeRelationships = vi.fn().mockResolvedValue(undefined);
    const spicedb = mockSpiceDb({ writeRelationships });

    await ensureGroupMembership(spicedb, "family", { type: "person", id: "mom" });

    expect(writeRelationships).toHaveBeenCalledWith([
      {
        resourceType: "group",
        resourceId: "family",
        relation: "member",
        subjectType: "person",
        subjectId: "mom",
      },
    ]);
  });
});
