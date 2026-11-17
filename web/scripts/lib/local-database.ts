import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Client } from "pg";
import { seedDevelopmentData } from "../development-seed";
import { grantApplicationRole, migrateDatabase, requireManagementRole } from "./database-management";

type Environment = Readonly<Record<string, string | undefined>>;
type SetupMode = "setup" | "seed" | "reset";

export function localSetupMode(args: string[]): SetupMode {
  if (!args.length) return "setup";
  if (args.length === 1 && args[0] === "--seed-only") return "seed";
  if (args.length === 1 && args[0] === "--reset-local") return "reset";
  throw new Error("Usage: setup-db.ts [--seed-only | --reset-local]");
}

export function localDatabaseTarget(environment: Environment, reset = false) {
  try {
    const url = new URL(environment.DATABASE_URL_DIRECT ?? "");
    if (environment.NODE_ENV === "production" || environment.VERCEL ||
      url.protocol !== "postgresql:" || !["db", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/team_b_dev" || url.username !== "team_b" || !url.password ||
      (url.port && url.port !== "5432") || url.search || url.hash ||
      (reset && (environment.NODE_ENV !== "development" || environment.LOCAL_DATABASE_RESET !== "team-b-compose-local"))) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error("開発DBの初期化はローカルの team_b_dev 専用です。リセットには開発Composeの明示設定が必要です。");
  }
}

export async function setupLocalDatabase(client: Client, environment: Environment, mode: SetupMode, credentialsDir = ".seed") {
  localDatabaseTarget(environment, mode === "reset");
  const actual = await client.query<{ database: string; role: string }>(
    "SELECT current_database() AS database, current_user AS role",
  );
  if (actual.rows[0].database !== "team_b_dev" || actual.rows[0].role !== "team_b") {
    throw new Error("開発DBの実接続先が一致しません。");
  }
  await requireManagementRole(client);
  await client.query("SELECT pg_advisory_lock($1)", [7249352026]);
  try {
    if (mode === "reset") {
      // 接続先限定の明示リセット。資格情報ファイルは維持する。
      await client.query("BEGIN");
      try {
        await client.query("DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    if (mode !== "seed") {
      await migrateDatabase(client);
      await client.query(await readFile("./scripts/local-db-grants.sql", "utf8"));
      await grantApplicationRole(client, "team_b_app");
    }
    return await seedDevelopmentData(drizzle(client), credentialsDir);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7249352026]);
  }
}
