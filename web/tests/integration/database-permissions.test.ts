import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseConfig } from "../../src/db/config";
import { requireApplicationRole } from "../../src/db/permissions";
import { applicationTables, grantApplicationRole, migrateDatabase } from "../../scripts/lib/database-management";
import { verifyApplicationRoundTrip } from "../../scripts/lib/poc-database";
import { endPool, isolatedDatabase } from "./isolated-database";

vi.mock("server-only", () => ({}));

const role = `app_${randomUUID().replaceAll("-", "")}`;
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let app: Client;
let appUrl: string;

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  await target.admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'integration-test-only'`);
  await grantApplicationRole(target.client, role);
  const url = new URL(target.url);
  url.username = role;
  url.password = "integration-test-only";
  appUrl = url.toString();
  app = new Client(databaseConfig({ DATABASE_URL: appUrl }));
  await app.connect();
});

afterAll(async () => {
  await app?.end();
  await target?.dispose();
  // dispose後は管理接続も切断済みなので、テストの親DBへ接続し直す。
  if (target) {
    const url = new URL(target.url);
    url.pathname = "/team_b_test";
    const admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    try { await admin.query(`DROP ROLE IF EXISTS "${role}"`); }
    finally { await admin.end(); }
  }
});

it("アプリ用ロールは全31テーブルを読み書きでき、監査は追記・参照だけできる", async () => {
  await expect(requireApplicationRole(app)).resolves.toBeUndefined();
  await expect(requireApplicationRole(target.client)).rejects.toThrow("専用アプリ用ロール");
  for (const table of applicationTables) {
    const result = await app.query<{ read: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>(
      `SELECT has_table_privilege(current_user, $1, 'SELECT') AS read,
        has_table_privilege(current_user, $1, 'INSERT') AS insert,
        has_table_privilege(current_user, $1, 'UPDATE') AS update,
        has_table_privilege(current_user, $1, 'DELETE') AS delete,
        has_table_privilege(current_user, $1, 'TRUNCATE') AS truncate`, [`public."${table}"`]);
    expect(result.rows[0], table).toEqual({ read: true, insert: true, update: table !== "audit_logs", delete: table !== "audit_logs", truncate: false });
  }
  await app.query("BEGIN");
  try {
    const inserted = await app.query("INSERT INTO audit_logs (system_action, action_type, target_type, target_id) VALUES (true, 'test', 'test', 'test') RETURNING id");
    expect((await app.query("SELECT id FROM audit_logs WHERE id=$1", [inserted.rows[0].id])).rowCount).toBe(1);
  } finally { await app.query("ROLLBACK"); }
  await verifyApplicationRoundTrip(app);
  await verifyApplicationRoundTrip(app);
  expect((await app.query("SELECT count(*)::int AS count FROM qa_categories")).rows[0].count).toBe(0);
});

it.each([
  "CREATE TABLE public.forbidden (id int)",
  "CREATE TEMP TABLE forbidden (id int)",
  "CREATE SCHEMA forbidden",
  "ALTER TABLE public.qa_categories ADD COLUMN forbidden int",
  "DROP TABLE public.qa_categories CASCADE",
  "TRUNCATE public.audit_logs",
  "UPDATE public.audit_logs SET target_id='forbidden'",
  "DELETE FROM public.audit_logs",
  "SELECT * FROM drizzle.__drizzle_migrations",
  `SET ROLE "${role}"; CREATE ROLE forbidden`,
])("アプリ接続は管理操作を拒否する: %s", async (query) => {
  await expect(app.query(query)).rejects.toMatchObject({ code: "42501" });
});

it("アプリ用接続ではマイグレーションを開始できない", async () => {
  await expect(migrateDatabase(app)).rejects.toThrow("管理用ロール");
  await expect(migrateDatabase(target.client)).resolves.toBeUndefined();
  await expect(grantApplicationRole(target.client, target.url.username)).rejects.toThrow("専用ロール");
  await expect(grantApplicationRole(target.client, 'bad"; DROP SCHEMA public CASCADE; --')).rejects.toThrow("APP_DATABASE_ROLE");
});

it("共通プールを使ったDrizzleの読み書きと再読み込みで接続数が増え続けない", async () => {
  vi.stubEnv("DATABASE_URL", appUrl);
  const { applicationPool } = await import("../../src/db/pool");
  const pool = applicationPool();
  const { db } = await import("../../src/db/client");
  try {
    for (let i = 0; i < 10; i++) {
      vi.resetModules();
      expect((await import("../../src/db/pool")).applicationPool()).toBe(pool);
      const rollback = new Error("rollback");
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO qa_categories (code, name) VALUES ('pool-probe', '確認')`);
        expect((await tx.execute(sql`SELECT * FROM qa_categories WHERE code='pool-probe'`)).rowCount).toBe(1);
        throw rollback;
      })).rejects.toBe(rollback);
    }
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
  } finally {
    await endPool(pool);
    delete (globalThis as { teamBDatabasePool?: unknown }).teamBDatabasePool;
    vi.unstubAllEnvs();
  }
});
