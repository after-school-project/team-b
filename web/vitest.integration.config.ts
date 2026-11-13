import nextEnv from "@next/env";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { requireTestDatabaseUrl } from "./scripts/lib/test-database";

nextEnv.loadEnvConfig(fileURLToPath(new URL("./", import.meta.url)));
requireTestDatabaseUrl(process.env);

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    passWithNoTests: false,
  },
});
