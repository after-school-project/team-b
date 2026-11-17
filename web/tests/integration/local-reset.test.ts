import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { requireTestDatabaseUrl } from "../../scripts/lib/test-database";
import { setupLocalDatabase } from "../../scripts/lib/local-database";
import { isolatedDatabase } from "./isolated-database";

let admin: Client;
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let local: Client;
let credentialsDir: string;
let environment: Record<string, string>;
let createdRoles = false;

beforeAll(async () => {
  // DBとロールを作る前に、隔離用ヘルパーと同じ接続先限定を適用する。
  const testUrl = new URL(requireTestDatabaseUrl(process.env));
  if (!["db", "localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname) || testUrl.pathname !== "/team_b_test" || testUrl.search || testUrl.hash) {
    throw new Error("リセットテストは使い捨てローカル team_b_test 専用です。");
  }
  admin = new Client({ connectionString: requireTestDatabaseUrl(process.env) });
  await admin.connect();
  const existing = await admin.query("SELECT FROM pg_roles WHERE rolname IN ('team_b', 'team_b_app')");
  if (existing.rowCount !== 0) throw new Error("リセット検証用ロールが既に存在します。使い捨てクラスタを再作成してください。");
  // 使い捨てテストクラスタ内に限り、開発Composeと同じ名前の接続先を再現する。
  await admin.query("CREATE ROLE team_b LOGIN SUPERUSER PASSWORD 'integration-test-only'");
  createdRoles = true;
  target = await isolatedDatabase("team_b_dev", "team_b");
  const url = new URL(target.url);
  url.username = "team_b";
  url.password = "integration-test-only";
  local = new Client({ connectionString: url.toString() });
  await local.connect();
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-reset-test-"));
  environment = { DATABASE_URL_DIRECT: url.toString(), NODE_ENV: "development", LOCAL_DATABASE_RESET: "team-b-compose-local" };
  vi.stubEnv("BETTER_AUTH_SECRET", "integration-test-only-secret-at-least-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
});

afterAll(async () => {
  await local?.end();
  await target?.dispose();
  if (admin) {
    if (createdRoles) await admin.query("DROP ROLE IF EXISTS team_b_app, team_b");
    await admin.end();
  }
  if (credentialsDir) {
    const path = resolve(credentialsDir);
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith("team-b-reset-test-")) throw new Error("Unsafe temporary directory");
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

it("通常再初期化は変更とパスワードを保持し、明示リセットは主要サンプルを再作成する", async () => {
  expect(await setupLocalDatabase(local, environment, "setup", credentialsDir)).toBe(10);
  const credentials = await readFile(join(credentialsDir, "accounts.json"), "utf8");
  await local.query("INSERT INTO qa_categories (code, name) VALUES ('reset-marker', '消去対象')");
  await local.query("UPDATE community_users SET app_manager=true WHERE user_id=(SELECT id FROM public.user WHERE username='poc_s001')");
  expect(await setupLocalDatabase(local, environment, "setup", credentialsDir)).toBe(0);
  expect((await local.query("SELECT * FROM qa_categories WHERE code='reset-marker'")).rowCount).toBe(1);
  expect((await local.query("SELECT c.app_manager FROM community_users c JOIN public.user u ON u.id=c.user_id WHERE u.username='poc_s001'")).rows[0].app_manager).toBe(true);

  for (let i = 0; i < 2; i++) {
    expect(await setupLocalDatabase(local, environment, "reset", credentialsDir)).toBe(10);
    expect((await local.query("SELECT * FROM qa_categories WHERE code='reset-marker'")).rowCount).toBe(0);
    expect((await local.query("SELECT c.app_manager FROM community_users c JOIN public.user u ON u.id=c.user_id WHERE u.username='poc_s001'")).rows[0].app_manager).toBe(false);
    expect((await local.query('SELECT * FROM public."user"')).rowCount).toBe(10);
    expect((await local.query("SELECT * FROM qa_categories")).rowCount).toBe(4);
    for (const table of ["profiles", "profile_reviews", "qa_questions", "qa_responses", "notices", "notice_revisions", "notice_requests",
      "events", "event_revisions", "event_requests", "reports", "report_cases", "evidence_snapshots", "notifications", "audit_logs"]) {
      expect((await local.query(`SELECT * FROM ${table}`)).rowCount, table).toBeGreaterThan(0);
    }
    expect(await readFile(join(credentialsDir, "accounts.json"), "utf8")).toBe(credentials);
  }
}, 60_000);

it("接続先のURLと実DBが一致しなければ、破壊操作前に拒否する", async () => {
  await expect(setupLocalDatabase(admin, environment, "reset", credentialsDir)).rejects.toThrow("実接続先");
  await expect(setupLocalDatabase(local, { ...environment, NODE_ENV: "production" }, "reset", credentialsDir)).rejects.toThrow("ローカル");
  expect((await local.query('SELECT * FROM public."user"')).rowCount).toBe(10);
});
