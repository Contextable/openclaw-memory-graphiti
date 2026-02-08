import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// When running standalone (outside the openclaw monorepo), resolve the
// plugin-sdk types from a sibling openclaw checkout.  Inside the monorepo
// the parent vitest config handles this, so this file is only used for
// standalone `pnpm test` runs.
const openclawRoot =
  process.env.OPENCLAW_ROOT ?? path.resolve(rootDir, "..", "openclaw");

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk": path.join(openclawRoot, "src", "plugin-sdk", "index.ts"),
    },
  },
  test: {
    testTimeout: 120_000,
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
  },
});
