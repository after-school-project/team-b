import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { loadAccessState, requireActive } from "../../src/auth/access";
import { loadAppShellViewer } from "../../src/components/app-shell/screen";
import { endPool, isolatedDatabase } from "./isolated-database";

vi.mock("server-only", () => ({}));

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 2 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-shell-test-"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
});

afterAll(async () => {
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

async function userId(username: string): Promise<string> {
  const { rows: [user] } = await target.client.query<{ id: string }>(
    'SELECT id FROM "user" WHERE username = $1', [username],
  );
  if (!user) throw new Error(`${username} がありません`);
  return user.id;
}

/** 画面の入口と同じく、最新の利用状態を読んでから共通レイアウト用の情報を作る。 */
async function shellFor(username: string) {
  const reader = drizzle(pool);
  const viewer = requireActive(await loadAccessState(reader, await userId(username)));
  return loadAppShellViewer(viewer, reader);
}

it.each([
  ["poc_s001", "はる"],
  ["poc_a001", "あおい"],
  ["poc_hidden", "ゆう"],
])("%s の表示名は本人プロフィールの現在版（%s）", async (username, displayName) => {
  expect((await shellFor(username)).displayName).toBe(displayName);
});

it("プロフィールを更新すると、現在版の表示名に切り替わる", async () => {
  const id = await userId("poc_s002");
  await target.client.query(`
    WITH revision AS (
      INSERT INTO profile_revisions (user_id, revision_no, display_name)
      SELECT $1, max(revision_no) + 1, '新しい表示名' FROM profile_revisions WHERE user_id = $1
      RETURNING id
    )
    UPDATE profiles SET current_revision_id = (SELECT id FROM revision), version = version + 1 WHERE user_id = $1
  `, [id]);
  expect((await shellFor("poc_s002")).displayName).toBe("新しい表示名");
});

it.each([
  ["poc_school", true, "学校管理者"],
  ["poc_s_mgr", true, "在校生のアプリ管理者"],
  ["poc_staff_mgr", true, "学校職員のアプリ管理者"],
  ["poc_s001", false, "一般の在校生"],
  ["poc_staff", false, "管理権限のない学校職員"],
])("%s の管理導線の表示は %s（%s）", async (username, canAccessAdmin) => {
  expect((await shellFor(username)).canAccessAdmin).toBe(canAccessAdmin);
});

it("プロフィール非表示中のアプリ管理者には管理導線を出さず、再公開後は出す", async () => {
  const id = await userId("poc_a_mgr");
  expect((await shellFor("poc_a_mgr")).canAccessAdmin).toBe(true);
  await target.client.query("UPDATE community_users SET profile_state = 'hidden' WHERE user_id = $1", [id]);
  expect((await shellFor("poc_a_mgr")).canAccessAdmin).toBe(false);
  await target.client.query("UPDATE community_users SET profile_state = 'public' WHERE user_id = $1", [id]);
  expect((await shellFor("poc_a_mgr")).canAccessAdmin).toBe(true);
});

it("アプリ管理者の権限を解除すると、次の表示から管理導線を出さない", async () => {
  const id = await userId("poc_staff_mgr");
  await target.client.query("UPDATE community_users SET app_manager = false WHERE user_id = $1", [id]);
  expect((await shellFor("poc_staff_mgr")).canAccessAdmin).toBe(false);
});
