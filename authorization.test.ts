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
    deleteRelationshipsByFilter: vi.fn().mockResolvedValue("delete-token-1"),
    bulkImportRelationships: vi.fn().mockResolvedValue(0),
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
      consistency: undefined,
    });
    expect(groups).toEqual(["family", "work"]);
  });

  test("passes at_least_as_fresh consistency when zedToken provided", async () => {
    const lookupResources = vi.fn().mockResolvedValue(["family"]);
    const spicedb = mockSpiceDb({ lookupResources });

    await lookupAuthorizedGroups(spicedb, { type: "agent", id: "pi" }, "tok-abc");

    expect(lookupResources).toHaveBeenCalledWith({
      resourceType: "group",
      permission: "access",
      subjectType: "agent",
      subjectId: "pi",
      consistency: { mode: "at_least_as_fresh", token: "tok-abc" },
    });
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
      consistency: undefined,
    });
    expect(frags).toEqual(["frag-1", "frag-2"]);
  });
});

describe("writeFragmentRelationships", () => {
  test("writes source_group and shared_by relationships", async () => {
    const writeRelationships = vi.fn().mockResolvedValue("write-tok-1");
    const spicedb = mockSpiceDb({ writeRelationships });

    const token = await writeFragmentRelationships(spicedb, {
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
    expect(token).toBe("write-tok-1");
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
  test("uses filter-based deletion for all fragment relationships", async () => {
    const deleteRelationshipsByFilter = vi.fn().mockResolvedValue("delete-token-1");
    const spicedb = mockSpiceDb({ deleteRelationshipsByFilter });

    const token = await deleteFragmentRelationships(spicedb, "ep-123");

    expect(deleteRelationshipsByFilter).toHaveBeenCalledTimes(1);
    expect(deleteRelationshipsByFilter).toHaveBeenCalledWith({
      resourceType: "memory_fragment",
      resourceId: "ep-123",
    });
    expect(token).toBe("delete-token-1");
  });

  test("works regardless of which group the fragment was stored to", async () => {
    const deleteRelationshipsByFilter = vi.fn().mockResolvedValue("token-2");
    const spicedb = mockSpiceDb({ deleteRelationshipsByFilter });

    // No group or sharedBy needed — filter-based delete handles any fragment
    await deleteFragmentRelationships(spicedb, "ep-non-default-group");

    expect(deleteRelationshipsByFilter).toHaveBeenCalledWith({
      resourceType: "memory_fragment",
      resourceId: "ep-non-default-group",
    });
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
      consistency: undefined,
    });
  });

  test("returns false when subject lacks delete permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(false);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canDeleteFragment(spicedb, { type: "person", id: "mom" }, "ep-123");
    expect(allowed).toBe(false);
  });

  test("uses at_least_as_fresh consistency when zedToken provided", async () => {
    const checkPermission = vi.fn().mockResolvedValue(true);
    const spicedb = mockSpiceDb({ checkPermission });

    await canDeleteFragment(spicedb, { type: "agent", id: "pi" }, "ep-123", "tok-del");

    expect(checkPermission).toHaveBeenCalledWith({
      resourceType: "memory_fragment",
      resourceId: "ep-123",
      permission: "delete",
      subjectType: "agent",
      subjectId: "pi",
      consistency: { mode: "at_least_as_fresh", token: "tok-del" },
    });
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
      consistency: undefined,
    });
  });

  test("returns false when subject lacks contribute permission", async () => {
    const checkPermission = vi.fn().mockResolvedValue(false);
    const spicedb = mockSpiceDb({ checkPermission });

    const allowed = await canWriteToGroup(spicedb, { type: "person", id: "outsider" }, "family");
    expect(allowed).toBe(false);
  });

  test("uses at_least_as_fresh consistency when zedToken provided", async () => {
    const checkPermission = vi.fn().mockResolvedValue(true);
    const spicedb = mockSpiceDb({ checkPermission });

    await canWriteToGroup(spicedb, { type: "agent", id: "pi" }, "family", "tok-write");

    expect(checkPermission).toHaveBeenCalledWith({
      resourceType: "group",
      resourceId: "family",
      permission: "contribute",
      subjectType: "agent",
      subjectId: "pi",
      consistency: { mode: "at_least_as_fresh", token: "tok-write" },
    });
  });
});

describe("ensureGroupMembership", () => {
  test("writes group member relationship and returns token", async () => {
    const writeRelationships = vi.fn().mockResolvedValue("membership-tok");
    const spicedb = mockSpiceDb({ writeRelationships });

    const token = await ensureGroupMembership(spicedb, "family", { type: "person", id: "mom" });

    expect(writeRelationships).toHaveBeenCalledWith([
      {
        resourceType: "group",
        resourceId: "family",
        relation: "member",
        subjectType: "person",
        subjectId: "mom",
      },
    ]);
    expect(token).toBe("membership-tok");
  });
});
