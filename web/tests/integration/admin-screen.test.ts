import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { POST as authPost } from "../../src/app/api/auth/[...auth]/route";
import type { AdminScope } from "../../src/auth/admin";
import { requireAdminScreen, requireAppScreen } from "../../src/components/app-shell/screen";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 管理エリアの画面の入口（#7 AC-08 の画面部分、⑥「画面URLの直接アクセス」）。
 * 管理画面のURLを直接開いた場合と同じく、ページの先頭で呼ぶ `requireAdminScreen` を要求ヘッダーから実行する。
 * 管理画面そのもの（AD-01・AD-11 など）の表示は、各画面を実装する機能Issue（#8・#16 など）で確認する。
 */

const origin = "https://school.example";
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let ipCounter = 0;
const ids = new Map<string, string>();

/** 画面の入口へ渡す要求ヘッダー。Next.js の要求の代わりに使う。 */
const screen = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));
vi.mock("next/headers", () => ({ headers: async () => screen.headers }));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  },
}));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-admin-screen-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user"');
  for (const { id, username } of rows) ids.set(username, id);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

// 各テストは seed の初期状態から始める（管理権限・停止・プロフィール状態を戻す）。
beforeEach(async () => {
  screen.headers = new Headers();
  await target.client.query(`
    UPDATE community_users SET account_status = 'active', profile_state = 'public',
      app_manager = user_id IN (SELECT id FROM "user" WHERE username IN ('poc_s_mgr', 'poc_a_mgr', 'poc_staff_mgr'))
    WHERE user_id IN (SELECT id FROM "user" WHERE username LIKE 'poc\\_%' AND username NOT IN ('poc_suspended', 'poc_hidden'))
  `);
});

function userId(username: string): string {
  const id = ids.get(username);
  if (!id) throw new Error(`${username} がありません`);
  return id;
}

async function openAs(username: string) {
  const response = await authPost(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${++ipCounter}`,
    },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  screen.headers = new Headers({ Cookie: cookie });
}

async function access(scope: AdminScope, path = "/admin") {
  return (await requireAdminScreen(scope, path)).access;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return (error as Error & { path: string }).path;
    throw error;
  }
  throw new Error("リダイレクトしませんでした");
}

async function setUser(username: string, values: string) {
  await target.client.query(`UPDATE community_users SET ${values} WHERE user_id = $1`, [userId(username)]);
}

it.each([
  ["poc_school", "granted", "granted"],
  ["poc_s_mgr", "granted", "denied"],
  ["poc_a_mgr", "granted", "denied"],
  ["poc_staff_mgr", "granted", "denied"],
  ["poc_s001", "denied", "denied"],
  ["poc_a001", "denied", "denied"],
  ["poc_staff", "denied", "denied"],
])("%s は両管理者の管理画面で %s、学校専用の管理画面で %s", async (username, any, school) => {
  await openAs(username);
  expect(await access("any")).toBe(any);
  expect(await access("school", "/admin/audit-logs")).toBe(school);

  // 拒否された場合もログインは維持し、共通レイアウトの管理導線は管理エリアの入口条件と一致する。
  const screenState = await requireAdminScreen("any", "/admin");
  expect(screenState.viewer.userId).toBe(userId(username));
  expect(screenState.shell.canAccessAdmin).toBe(any === "granted");
});

it("管理者権限を解除した直後、既存セッションの次の管理画面の表示から拒否し、一般の画面は利用できる", async () => {
  await openAs("poc_staff_mgr");
  expect(await access("any")).toBe("granted");

  await setUser("poc_staff_mgr", "app_manager = false");
  expect(await access("any")).toBe("denied");
  const general = await requireAppScreen("/");
  expect(general.viewer.userId).toBe(userId("poc_staff_mgr"));
  expect(general.shell.canAccessAdmin).toBe(false);

  // 再付与すれば、同じセッションの次の表示から管理画面を利用できる。
  await setUser("poc_staff_mgr", "app_manager = true");
  expect(await access("any")).toBe("granted");
});

it("プロフィール非表示中のアプリ管理者は管理画面を利用できず、一般の画面は利用できる", async () => {
  await openAs("poc_a_mgr");
  await setUser("poc_a_mgr", "profile_state = 'hidden'");
  expect(await access("any")).toBe("denied");
  expect((await requireAppScreen("/")).viewer.userId).toBe(userId("poc_a_mgr"));
});

it("停止中の管理者は、管理画面でも拒否表示ではなく停止案内（ログイン画面の入口）へ移動する", async () => {
  await openAs("poc_s_mgr");
  await setUser("poc_s_mgr", "account_status = 'suspended'");
  expect(await redirectOf(() => requireAdminScreen("any", "/admin"))).toBe("/login");
});

it("未認証・発行未完了は、管理画面の判定より先にログイン画面へ移動する", async () => {
  expect(await redirectOf(() => requireAdminScreen("any", "/admin"))).toBe("/login");

  await openAs("poc_school");
  await setUser("poc_school", "eligibility_status = 'pending'");
  try {
    expect(await redirectOf(() => requireAdminScreen("school", "/admin/audit-logs"))).toBe("/login");
  } finally {
    await setUser("poc_school", "eligibility_status = 'verified'");
  }
});
