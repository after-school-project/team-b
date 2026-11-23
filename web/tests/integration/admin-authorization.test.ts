import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { defineAdminApiRoute } from "../../src/api/admin-route";
import { defineAuthorizedApiRoute } from "../../src/api/authorized-route";
import { commitMutation } from "../../src/api/mutation";
import { POST as authPost } from "../../src/app/api/auth/[...auth]/route";
import { authorizeAdminEntry, requireAdminForLockedTarget, type AdminScope } from "../../src/auth/admin";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 管理権限の共通判定（#7 ⑤）。権限詳細設計書 7節のうち、共通認可だけで確認できる
 * SEC-17（拒否部分）・SEC-18・SEC-26 を、共通認可を使う検証用の経路で確認する。
 */

const origin = "https://school.example";
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let ipCounter = 0;
const ids = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-admin-test-"));
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

async function logIn(username: string) {
  const response = await authPost(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${++ipCounter}`,
    },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
}

const adminRoutes = {
  any: defineAdminApiRoute("any", { GET: (_request, _context, viewer) => ({ data: { viewerId: viewer.userId } }) }),
  school: defineAdminApiRoute("school", { GET: (_request, _context, viewer) => ({ data: { viewerId: viewer.userId } }) }),
};
const generalRoute = defineAuthorizedApiRoute({ GET: (_request, _context, viewer) => ({ data: { viewerId: viewer.userId } }) });

async function get(route: { GET: (request: Request, context: unknown) => Promise<Response> }, cookie: string) {
  const response = await route.GET(new Request(origin + "/api/v1/admin/sample", { headers: { Cookie: cookie } }), {});
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function expectDenied(route: Parameters<typeof get>[0], cookie: string, code: string) {
  const { status, body } = await get(route, cookie);
  expect({ status, code: (body.error as { code?: string } | undefined)?.code }).toEqual({ status: 403, code });
  // 拒否時は業務データ・権限の内訳を返さない。
  expect(Object.keys(body).sort()).toEqual(["error", "meta"]);
}

async function setUser(username: string, values: string) {
  await target.client.query(`UPDATE community_users SET ${values} WHERE user_id = $1`, [userId(username)]);
}

it.each([
  ["poc_school", 200, 200],
  ["poc_s_mgr", 200, 403],
  ["poc_a_mgr", 200, 403],
  ["poc_staff_mgr", 200, 403],
  ["poc_s001", 403, 403],
  ["poc_staff", 403, 403],
])("%s は両管理者の管理APIで %s、学校専用の管理APIで %s", async (username, any, school) => {
  const cookie = await logIn(username);
  expect((await get(adminRoutes.any, cookie)).status).toBe(any);
  expect((await get(adminRoutes.school, cookie)).status).toBe(school);
  if (any === 403) await expectDenied(adminRoutes.any, cookie, "FORBIDDEN");
  if (school === 403) await expectDenied(adminRoutes.school, cookie, "FORBIDDEN");
  // 管理権限の有無にかかわらず、一般の業務APIは利用できる。
  expect((await get(generalRoute, cookie)).status).toBe(200);
});

it("SEC-18：管理者権限を解除した直後、既存セッションの管理API呼び出しを拒否し、一般ログインは維持する", async () => {
  const cookie = await logIn("poc_staff_mgr");
  expect((await get(adminRoutes.any, cookie)).status).toBe(200);

  await setUser("poc_staff_mgr", "app_manager = false");
  await expectDenied(adminRoutes.any, cookie, "FORBIDDEN");
  expect(await get(generalRoute, cookie)).toMatchObject({ status: 200, body: { data: { viewerId: userId("poc_staff_mgr") } } });

  // 再付与すれば、同じセッションの次の要求から管理APIを利用できる。
  await setUser("poc_staff_mgr", "app_manager = true");
  expect((await get(adminRoutes.any, cookie)).status).toBe(200);
});

it("SEC-17（拒否部分）：プロフィール非表示中のアプリ管理者は管理APIを利用できず、一般の利用は続けられる", async () => {
  const cookie = await logIn("poc_a_mgr");
  expect((await get(adminRoutes.any, cookie)).status).toBe(200);

  await setUser("poc_a_mgr", "profile_state = 'hidden'");
  await expectDenied(adminRoutes.any, cookie, "FORBIDDEN");
  expect((await get(generalRoute, cookie)).status).toBe(200);
});

it("SEC-26：プロフィール再公開後も、管理ロールが残ったまま停止中のアカウントは管理APIを利用できない", async () => {
  const cookie = await logIn("poc_s_mgr");
  await setUser("poc_s_mgr", "profile_state = 'hidden'");
  await expectDenied(adminRoutes.any, cookie, "FORBIDDEN");

  // 再公開しても停止は自動解除されず、停止中として拒否する（管理ロールの有無を応答に出さない）。
  await setUser("poc_s_mgr", "profile_state = 'public', account_status = 'suspended'");
  await expectDenied(adminRoutes.any, cookie, "ACCOUNT_SUSPENDED");
  await expectDenied(adminRoutes.school, cookie, "ACCOUNT_SUSPENDED");
  await expectDenied(generalRoute, cookie, "ACCOUNT_SUSPENDED");
});

it("停止中の学校管理者も管理APIを利用できない", async () => {
  const cookie = await logIn("poc_school");
  await setUser("poc_school", "account_status = 'suspended'");
  await expectDenied(adminRoutes.school, cookie, "ACCOUNT_SUSPENDED");
});

/** 実行者の管理資格だけで決まる管理操作の更新。行ロック後に `authorizeAdminEntry` で再判定する。 */
function adminMutation(actor: string, scope: AdminScope) {
  return commitMutation(drizzle(pool), {
    actorId: actor,
    request: { method: "POST", path: "/api/v1/admin/sample", requestKey: randomUUID() },
    body: {},
    authorizeEntry: authorizeAdminEntry(actor, scope),
    authorizeReplay: async () => {},
    execute: async () => ({ status: 201, resource: { type: "sample", id: randomUUID() }, version: null, state: "done" }),
  });
}

/**
 * 対象者によって学校専用になる管理操作の更新（例：アカウントの停止）。
 * 入口では実行者の資格だけを確認し、対象者による区分は再送キーの照合後に `execute`・`authorizeReplay` で判定する。
 */
function targetMutation(actor: string, subject: string, requestKey = randomUUID()) {
  return commitMutation(drizzle(pool), {
    actorId: actor,
    request: { method: "POST", path: "/api/v1/admin/users/sample", requestKey },
    body: { subject },
    resolveUserIds: async () => [subject],
    authorizeEntry: authorizeAdminEntry(actor, "any"),
    authorizeReplay: async (context) => { await requireAdminForLockedTarget(context, actor, subject); },
    async execute(context) {
      await requireAdminForLockedTarget(context, actor, subject);
      return { status: 201, resource: { type: "user", id: subject }, version: null, state: "done" };
    },
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unexpected";
  }
}

it.each([
  ["poc_s_mgr", "poc_s001", null],
  ["poc_s_mgr", "poc_a_mgr", "FORBIDDEN"],
  ["poc_school", "poc_a_mgr", null],
  ["poc_school", "poc_s001", null],
  ["poc_s001", "poc_s002", "FORBIDDEN"],
])("対象者によって学校専用になる更新：%s が %s を対象にすると %s", async (actor, subject, expected) => {
  expect(await errorCode(targetMutation(userId(actor), userId(subject)))).toBe(expected);
});

it("存在しない対象者への、対象者によって学校専用になる更新は、有効な管理者には404", async () => {
  expect(await errorCode(targetMutation(userId("poc_school"), randomUUID()))).toBe("NOT_FOUND");
});

it("管理者でない実行者は、対象者の有無にかかわらず同じ403で拒否する", async () => {
  const actor = userId("poc_s001");
  expect(await errorCode(targetMutation(actor, userId("poc_s002")))).toBe("FORBIDDEN");
  expect(await errorCode(targetMutation(actor, randomUUID()))).toBe("FORBIDDEN");
});

it("再送キーの照合を対象者の判定より先に行い、同じキーを別の内容に使うと409", async () => {
  const actor = userId("poc_s_mgr");
  const key = randomUUID();
  expect(await errorCode(targetMutation(actor, userId("poc_s001"), key))).toBeNull();
  // 学校専用になる対象者・存在しない対象者でも、対象者の判定より先に再送キーの不一致を返す。
  expect(await errorCode(targetMutation(actor, userId("poc_a_mgr"), key))).toBe("IDEMPOTENCY_KEY_REUSED");
  expect(await errorCode(targetMutation(actor, randomUUID(), key))).toBe("IDEMPOTENCY_KEY_REUSED");
});

it("再送時も対象者の現在の管理権限で再判定する", async () => {
  const actor = userId("poc_s_mgr");
  const subject = userId("poc_s001");
  const key = randomUUID();
  expect(await errorCode(targetMutation(actor, subject, key))).toBeNull();
  expect(await errorCode(targetMutation(actor, subject, key))).toBeNull();
  await setUser("poc_s001", "app_manager = true");
  expect(await errorCode(targetMutation(actor, subject, key))).toBe("FORBIDDEN");
});

/** 別の接続で利用者の行をロックしたまま変更し、待機中の更新がコミット後の状態で判定されることを確認する。 */
async function changeWhileUpdating(username: string, values: string, update: () => Promise<unknown>) {
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT user_id FROM community_users WHERE user_id = $1 FOR UPDATE", [userId(username)]);
    const pending = errorCode(update());
    await waitForLockWait();
    await blocker.query(`UPDATE community_users SET ${values} WHERE user_id = $1`, [userId(username)]);
    await blocker.query("COMMIT");
    return await pending;
  } catch (error) {
    await blocker.query("ROLLBACK");
    throw error;
  } finally {
    blocker.release();
  }
}

async function waitForLockWait() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows: [row] } = await target.client.query<{ waiting: number }>(`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    if (row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("更新が行ロックを待っていません");
}

it("管理権限の解除と処理中の管理操作を直列化し、解除のコミット後は拒否する", async () => {
  const actor = userId("poc_staff_mgr");
  expect(await changeWhileUpdating("poc_staff_mgr", "app_manager = false", () => adminMutation(actor, "any")))
    .toBe("FORBIDDEN");
  // 解除前に確定した操作はそのまま有効で、解除後の操作は拒否する。
  await setUser("poc_staff_mgr", "app_manager = true");
  expect(await errorCode(adminMutation(actor, "any"))).toBeNull();
});

it("入口通過後に管理権限を解除された実行者は、対象者の有無にかかわらず同じ403で拒否する", async () => {
  const actor = userId("poc_staff_mgr");
  expect(await changeWhileUpdating("poc_staff_mgr", "app_manager = false", () => targetMutation(actor, userId("poc_s001"))))
    .toBe("FORBIDDEN");
  await setUser("poc_staff_mgr", "app_manager = true");
  expect(await changeWhileUpdating("poc_staff_mgr", "app_manager = false", () => targetMutation(actor, randomUUID())))
    .toBe("FORBIDDEN");
});

it("対象者のアプリ管理者化と処理中の操作を直列化し、アプリ管理者の操作は学校専用として拒否する", async () => {
  const actor = userId("poc_a_mgr");
  expect(await changeWhileUpdating("poc_s001", "app_manager = true", () => targetMutation(actor, userId("poc_s001"))))
    .toBe("FORBIDDEN");
});
