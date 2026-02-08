import { describe, test, expect, afterEach } from "vitest";
import { graphitiMemoryConfigSchema } from "./config.js";

describe("graphitiMemoryConfigSchema", () => {
  afterEach(() => {
    delete process.env.TEST_SPICEDB_TOKEN;
    delete process.env.TEST_AGENT_ID;
  });

  test("parses valid full config", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: {
        endpoint: "spicedb.example.com:50051",
        token: "my-token",
        insecure: false,
      },
      graphiti: {
        endpoint: "http://graphiti:8000",
        defaultGroupId: "family",
      },
      subjectType: "person",
      subjectId: "mom",
      autoCapture: true,
      autoRecall: false,
    });

    expect(config.spicedb.endpoint).toBe("spicedb.example.com:50051");
    expect(config.spicedb.token).toBe("my-token");
    expect(config.spicedb.insecure).toBe(false);
    expect(config.graphiti.endpoint).toBe("http://graphiti:8000");
    expect(config.graphiti.defaultGroupId).toBe("family");
    expect(config.subjectType).toBe("person");
    expect(config.subjectId).toBe("mom");
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(false);
  });

  test("applies defaults for optional fields", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
    });

    expect(config.spicedb.endpoint).toBe("localhost:50051");
    expect(config.spicedb.insecure).toBe(true);
    expect(config.graphiti.endpoint).toBe("http://localhost:8000");
    expect(config.graphiti.defaultGroupId).toBe("main");
    expect(config.subjectType).toBe("agent");
    expect(config.subjectId).toBe("default");
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(true);
  });

  test("resolves env vars in token", () => {
    process.env.TEST_SPICEDB_TOKEN = "secret-token-123";

    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "${TEST_SPICEDB_TOKEN}" },
    });

    expect(config.spicedb.token).toBe("secret-token-123");
  });

  test("resolves env vars in subjectId", () => {
    process.env.TEST_AGENT_ID = "agent-42";

    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      subjectId: "${TEST_AGENT_ID}",
    });

    expect(config.subjectId).toBe("agent-42");
  });

  test("throws on missing env var", () => {
    expect(() => {
      graphitiMemoryConfigSchema.parse({
        spicedb: { token: "${NONEXISTENT_VAR}" },
      });
    }).toThrow("Environment variable NONEXISTENT_VAR is not set");
  });

  test("throws on missing spicedb config", () => {
    expect(() => {
      graphitiMemoryConfigSchema.parse({});
    }).toThrow("spicedb.token is required");
  });

  test("throws on missing spicedb.token", () => {
    expect(() => {
      graphitiMemoryConfigSchema.parse({
        spicedb: { endpoint: "localhost:50051" },
      });
    }).toThrow("spicedb.token is required");
  });

  test("throws on unknown top-level keys", () => {
    expect(() => {
      graphitiMemoryConfigSchema.parse({
        spicedb: { token: "tok" },
        bogusKey: true,
      });
    }).toThrow("unknown keys: bogusKey");
  });

  test("throws on unknown spicedb keys", () => {
    expect(() => {
      graphitiMemoryConfigSchema.parse({
        spicedb: { token: "tok", badField: 123 },
      });
    }).toThrow("unknown keys: badField");
  });

  test("throws on non-object input", () => {
    expect(() => graphitiMemoryConfigSchema.parse(null)).toThrow("config required");
    expect(() => graphitiMemoryConfigSchema.parse("string")).toThrow("config required");
    expect(() => graphitiMemoryConfigSchema.parse([])).toThrow("config required");
  });

  // Phase 2: customInstructions and maxCaptureMessages

  test("applies default customInstructions", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
    });

    expect(config.customInstructions).toContain("Identity");
    expect(config.customInstructions).toContain("Preferences");
    expect(config.customInstructions).toContain("Goals");
  });

  test("accepts custom extraction instructions", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      customInstructions: "Only extract names and dates",
    });

    expect(config.customInstructions).toBe("Only extract names and dates");
  });

  test("applies default maxCaptureMessages", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
    });

    expect(config.maxCaptureMessages).toBe(10);
  });

  test("accepts custom maxCaptureMessages", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      maxCaptureMessages: 20,
    });

    expect(config.maxCaptureMessages).toBe(20);
  });

  test("ignores invalid maxCaptureMessages (uses default)", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      maxCaptureMessages: -5,
    });

    expect(config.maxCaptureMessages).toBe(10);
  });
});
