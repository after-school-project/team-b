import { defineConfig } from "drizzle-kit";

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
