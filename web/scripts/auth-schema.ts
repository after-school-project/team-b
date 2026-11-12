import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { authOptions } from "../src/auth/options";

// The CLI reads the model definitions without connecting to PostgreSQL.
export const auth = betterAuth({
  ...authOptions(drizzleAdapter(drizzle.mock(), { provider: "pg" })),
  baseURL: "http://localhost:3000",
  secret: "schema-generation-placeholder-not-a-runtime-secret",
});
