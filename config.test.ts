import { describe, test, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

  test("defaults spicedb config when omitted (installer-friendly)", () => {
    const config = graphitiMemoryConfigSchema.parse({});

    expect(config.spicedb.endpoint).toBe("localhost:50051");
    expect(config.spicedb.token).toBe("");
    expect(config.spicedb.insecure).toBe(true);
  });

  test("defaults spicedb.token to empty string when omitted", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { endpoint: "custom:50051" },
    });

    expect(config.spicedb.endpoint).toBe("custom:50051");
    expect(config.spicedb.token).toBe("");
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

  // UUID polling config

  test("applies default UUID polling config", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
    });

    expect(config.graphiti.uuidPollIntervalMs).toBe(3000);
    expect(config.graphiti.uuidPollMaxAttempts).toBe(30);
  });

  test("accepts custom UUID polling config", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      graphiti: { uuidPollIntervalMs: 5000, uuidPollMaxAttempts: 60 },
    });

    expect(config.graphiti.uuidPollIntervalMs).toBe(5000);
    expect(config.graphiti.uuidPollMaxAttempts).toBe(60);
  });

  test("ignores invalid UUID polling values (uses defaults)", () => {
    const config = graphitiMemoryConfigSchema.parse({
      spicedb: { token: "tok" },
      graphiti: { uuidPollIntervalMs: -1, uuidPollMaxAttempts: 0 },
    });

    expect(config.graphiti.uuidPollIntervalMs).toBe(3000);
    expect(config.graphiti.uuidPollMaxAttempts).toBe(30);
  });
});

// ============================================================================
// openclaw.plugin.json — install-time JSON Schema validation
//
// OpenClaw's installer validates plugin config against the JSON Schema in
// openclaw.plugin.json BEFORE the TypeScript parse() runs. These tests ensure
// both layers accept the empty config: {} that the installer writes.
// ============================================================================

describe("openclaw.plugin.json configSchema (install-time validation)", () => {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "openclaw.plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const jsonSchema = manifest.configSchema;

  test("manifest is valid JSON with configSchema", () => {
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeDefined();
  });

  test("top-level configSchema has no required fields", () => {
    // The installer writes config: {} — any top-level "required" will reject it
    expect(jsonSchema.required).toBeUndefined();
  });

  test("spicedb sub-schema has no required fields", () => {
    // Even if spicedb is provided as {}, no fields within should be required at install time
    const spicedbSchema = jsonSchema.properties?.spicedb;
    expect(spicedbSchema).toBeDefined();
    expect(spicedbSchema.required).toBeUndefined();
  });

  test("graphiti sub-schema has no required fields", () => {
    const graphitiSchema = jsonSchema.properties?.graphiti;
    expect(graphitiSchema).toBeDefined();
    expect(graphitiSchema.required).toBeUndefined();
  });

  test("no sub-schema anywhere has required fields", () => {
    // Walk the entire schema tree to catch any "required" we might miss
    const findRequired = (obj: unknown, path: string): string[] => {
      if (!obj || typeof obj !== "object") return [];
      const o = obj as Record<string, unknown>;
      const found: string[] = [];
      if (Array.isArray(o.required) && o.required.length > 0) {
        found.push(`${path}.required = ${JSON.stringify(o.required)}`);
      }
      if (o.properties && typeof o.properties === "object") {
        for (const [key, val] of Object.entries(o.properties as Record<string, unknown>)) {
          found.push(...findRequired(val, `${path}.properties.${key}`));
        }
      }
      return found;
    };

    const violations = findRequired(jsonSchema, "configSchema");
    expect(violations).toEqual([]);
  });

  test("TypeScript parse() accepts empty config (what installer writes)", () => {
    // This is the exact config the installer creates:
    //   plugins.entries.openclaw-memory-graphiti.config = {}
    expect(() => graphitiMemoryConfigSchema.parse({})).not.toThrow();
  });

  test("TypeScript parse() accepts config with empty spicedb object", () => {
    // Installer might also write { spicedb: {} } if user partially fills it
    expect(() => graphitiMemoryConfigSchema.parse({ spicedb: {} })).not.toThrow();
  });
});
