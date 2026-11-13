import { defineConfig } from "drizzle-kit";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/db/auth-schema.ts",
    "./src/db/schema.ts",
    "./src/db/content-schema.ts",
    "./src/db/moderation-schema.ts",
  ],
  out: "./drizzle",
  ...(process.env.DATABASE_URL_DIRECT
    ? { dbCredentials: { url: process.env.DATABASE_URL_DIRECT } }
    : {}),
});
