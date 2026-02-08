export type GraphitiMemoryConfig = {
  spicedb: {
    endpoint: string;
    token: string;
    insecure: boolean;
  };
  graphiti: {
    endpoint: string;
    defaultGroupId: string;
  };
  subjectType: "agent" | "person";
  subjectId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  customInstructions: string;
  maxCaptureMessages: number;
};

const DEFAULT_SPICEDB_ENDPOINT = "localhost:50051";
const DEFAULT_GRAPHITI_ENDPOINT = "http://localhost:8000";
const DEFAULT_GROUP_ID = "main";
const DEFAULT_SUBJECT_TYPE = "agent";
const DEFAULT_MAX_CAPTURE_MESSAGES = 10;

const DEFAULT_CUSTOM_INSTRUCTIONS = `Extract key facts about:
- Identity: names, roles, titles, contact info
- Preferences: likes, dislikes, preferred tools/methods
- Goals: objectives, plans, deadlines
- Relationships: connections between people, teams, organizations
- Decisions: choices made, reasoning, outcomes
- Routines: habits, schedules, recurring patterns
Do not extract: greetings, filler, meta-commentary about the conversation itself.`;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const graphitiMemoryConfigSchema = {
  parse(value: unknown): GraphitiMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-graphiti config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "spicedb", "graphiti", "subjectType", "subjectId",
        "autoCapture", "autoRecall", "customInstructions", "maxCaptureMessages",
      ],
      "memory-graphiti config",
    );

    // SpiceDB config
    const spicedb = cfg.spicedb as Record<string, unknown> | undefined;
    if (!spicedb || typeof spicedb.token !== "string") {
      throw new Error("spicedb.token is required");
    }
    assertAllowedKeys(spicedb, ["endpoint", "token", "insecure"], "spicedb config");

    // Graphiti config
    const graphiti = (cfg.graphiti as Record<string, unknown>) ?? {};
    assertAllowedKeys(graphiti, ["endpoint", "defaultGroupId"], "graphiti config");

    // Subject
    const subjectType = cfg.subjectType === "person" ? "person" : DEFAULT_SUBJECT_TYPE;
    const subjectId =
      typeof cfg.subjectId === "string" ? resolveEnvVars(cfg.subjectId) : "default";

    return {
      spicedb: {
        endpoint:
          typeof spicedb.endpoint === "string" ? spicedb.endpoint : DEFAULT_SPICEDB_ENDPOINT,
        token: resolveEnvVars(spicedb.token),
        insecure: spicedb.insecure !== false,
      },
      graphiti: {
        endpoint:
          typeof graphiti.endpoint === "string" ? graphiti.endpoint : DEFAULT_GRAPHITI_ENDPOINT,
        defaultGroupId:
          typeof graphiti.defaultGroupId === "string"
            ? graphiti.defaultGroupId
            : DEFAULT_GROUP_ID,
      },
      subjectType,
      subjectId,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions:
        typeof cfg.customInstructions === "string"
          ? cfg.customInstructions
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      maxCaptureMessages:
        typeof cfg.maxCaptureMessages === "number" && cfg.maxCaptureMessages > 0
          ? cfg.maxCaptureMessages
          : DEFAULT_MAX_CAPTURE_MESSAGES,
    };
  },
};
