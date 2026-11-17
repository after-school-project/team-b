import { getTableName, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import * as auth from "../../src/db/auth-schema";
import * as community from "../../src/db/schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";

export const applicationTables = Object.values({ ...auth, ...community, ...content, ...moderation })
  .filter((value) => is(value, Table)).map(getTableName).sort();

export async function requireManagementRole(client: Client) {
  const result = await client.query<{ allowed: boolean }>(
    "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed",
  );
  if (!result.rows[0].allowed) throw new Error("マイグレーションには管理用ロールの接続が必要です。");
}

export async function migrateDatabase(client: Client) {
  await requireManagementRole(client);
  await client.query("SELECT pg_advisory_lock($1)", [7249352026]);
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7249352026]);
  }
}

export function applicationRoleName(value: string | undefined) {
  if (!value || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("APP_DATABASE_ROLE にアプリ用ロール名（英小文字・数字・_）を設定してください。");
  }
  return value;
}

export async function grantApplicationRole(client: Client, name: string) {
  const role = applicationRoleName(name);
  await requireManagementRole(client);
  const result = await client.query<{ safe: boolean }>(`SELECT
    NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication)
    AND r.rolname <> current_user
    AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
    AND NOT EXISTS (SELECT FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = r.oid)
    AND NOT EXISTS (SELECT FROM pg_namespace WHERE nspowner = r.oid)
    AND NOT EXISTS (SELECT FROM pg_database WHERE datdba = r.oid) AS safe
    FROM pg_roles r WHERE rolname = $1`, [role]);
  if (!result.rows[0]?.safe) throw new Error("アプリ用ロールは所有権・管理権限・他ロールへの所属を持たない専用ロールにしてください。");

  // 識別子は上の許可リストで検証。テーブル名はコードで定義したスキーマのみ。
  const tables = applicationTables.map((table) => `public."${table}"`).join(", ");
  await client.query("BEGIN");
  try {
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, "${role}"`);
    await client.query(`DO $$ BEGIN EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, %I', current_database(), '${role}'); END $$`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(`REVOKE ALL ON ${tables} FROM PUBLIC, "${role}"`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO "${role}"`);
    await client.query(`REVOKE UPDATE, DELETE ON public.audit_logs FROM "${role}"`);
    await client.query(`REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, "${role}"`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, "${role}"`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
