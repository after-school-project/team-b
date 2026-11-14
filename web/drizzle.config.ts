import { defineConfig } from "drizzle-kit";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Drizzle Kitの設定ローダーとNode.jsのESMで、CJSの@next/envを同じ形で読む。
const { loadEnvConfig } = createRequire(resolve(process.cwd(), "package.json"))("@next/env") as typeof import("@next/env");
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

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
