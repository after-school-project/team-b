import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { commitMutation } from "../../src/api/mutation";
import { defineApiRoute } from "../../src/api/route";
import { POST as authPost } from "../../src/app/api/auth/[...auth]/route";
import { GET as meGet, POST as mePost } from "../../src/app/api/v1/me/route";
import { authorizeActiveEntry } from "../../src/auth/access";
import { isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let ipCounter = 0;

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-me-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await pool?.end();
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

async function logIn(username: string) {
  const response = await authPost(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${++ipCounter}`,
    },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  return { userId: user.id, cookie };
}

async function me(cookie?: string, { query = "", headers = {} }: { query?: string; headers?: Record<string, string> } = {}) {
  const response = await meGet(new Request(origin + "/api/v1/me" + query, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  }), {});
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return { status: response.status, body: await response.json() };
}

async function update(sql: string, userId: string) {
  await target.client.query(sql, [userId]);
}

it("未認証・失効・ログアウト済みのセッションを401 AUTH_REQUIRED にする", async () => {
  expect(await me()).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
  expect((await me("__Secure-better-auth.session_token=forged.value")).status).toBe(401);

  const { userId, cookie } = await logIn("poc_s001");
  expect((await me(cookie)).status).toBe(200);
  await update("UPDATE session SET expires_at = now() - interval '1 second' WHERE user_id = $1", userId);
  expect(await me(cookie)).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
});

it("有効な利用者に最新の所属・管理権限・アカウント・プロフィール状態を返す", async () => {
  const { userId, cookie } = await logIn("poc_a_mgr");
  const { rows: [session] } = await target.client.query<{ expires_at: Date }>(
    "SELECT expires_at FROM session WHERE user_id = $1", [userId],
  );
  const response = await me(cookie);
  expect(response.status).toBe(200);
  expect(response.body.data).toStrictEqual({
    access: "active",
    userId,
    baseRole: "alumni",
    isGraduating: false,
    profileState: "public",
    userVersion: 1,
    roles: { schoolManager: false, appManager: true },
    capabilities: { canEnterAdmin: true, canWriteContent: true },
    sessionExpiresAt: session.expires_at.toISOString(),
  });
  expect(Object.keys(response.body.meta).sort()).toEqual(["requestId", "serverTime"]);

  const school = await me((await logIn("poc_school")).cookie);
  expect(school.body.data).toMatchObject({
    baseRole: "staff", roles: { schoolManager: true, appManager: false }, capabilities: { canEnterAdmin: true },
  });
  const hidden = await me((await logIn("poc_hidden")).cookie);
  expect(hidden.body.data).toMatchObject({
    profileState: "hidden", capabilities: { canEnterAdmin: false, canWriteContent: false },
  });
});

it("権限・状態の変更を同じセッションの次の要求に反映する", async () => {
  const { userId, cookie } = await logIn("poc_s_mgr");
  expect((await me(cookie)).body.data).toMatchObject({ roles: { appManager: true }, capabilities: { canEnterAdmin: true } });

  await update("UPDATE community_users SET app_manager = false, version = version + 1 WHERE user_id = $1", userId);
  expect((await me(cookie)).body.data).toMatchObject({
    access: "active", userVersion: 2, roles: { appManager: false }, capabilities: { canEnterAdmin: false },
  });

  await update("UPDATE community_users SET profile_state = 'hidden', app_manager = true WHERE user_id = $1", userId);
  expect((await me(cookie)).body.data).toMatchObject({
    profileState: "hidden", roles: { appManager: true }, capabilities: { canEnterAdmin: false, canWriteContent: false },
  });
});

it("停止中は本人向けの停止理由だけを返し、停止後の既存セッションにも反映する", async () => {
  const suspended = await me((await logIn("poc_suspended")).cookie);
  expect(suspended.status).toBe(200);
  expect(suspended.body.data).toStrictEqual({ access: "suspended", publicReason: expect.any(String) });
  expect(suspended.body.data.publicReason.trim()).not.toBe("");

  const { userId, cookie } = await logIn("poc_s002");
  await target.client.query(`
    WITH changed AS (UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1 RETURNING user_id)
    INSERT INTO account_restrictions (user_id, actor_id, action, public_reason, internal_reason)
    SELECT user_id, (SELECT user_id FROM community_users cu JOIN "user" u ON u.id = cu.user_id WHERE u.username = 'poc_school'),
      'suspend', '本人向けの理由', '内部用の理由' FROM changed
  `, [userId]);
  const response = await me(cookie);
  expect(response.body.data).toStrictEqual({ access: "suspended", publicReason: "本人向けの理由" });
  expect(JSON.stringify(response.body)).not.toContain("内部用の理由");
});

it.each([
  ["発行未完了", "provisioning_status = 'pending'"],
  ["学校確認未完了", "eligibility_status = 'pending'"],
])("%sは403 ACCOUNT_NOT_READY とし、個人データを返さない", async (_label, change) => {
  const { userId, cookie } = await logIn("poc_staff");
  await update(`UPDATE community_users SET ${change} WHERE user_id = $1`, userId);
  const response = await me(cookie);
  expect(response).toMatchObject({ status: 403, body: { error: { code: "ACCOUNT_NOT_READY", fields: [] } } });
  expect(response.body.data).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain(userId);
  await update("UPDATE community_users SET provisioning_status = 'ready', eligibility_status = 'verified' WHERE user_id = $1", userId);
});

it("送信された actorId・所属・権限では判定結果が変わらない", async () => {
  const { cookie } = await logIn("poc_s001");
  const school = await logIn("poc_school");
  const baseline = await me(cookie);
  const tampered = await me(cookie, {
    headers: { "X-Actor-Id": school.userId, "X-User-Id": school.userId, "X-Roles": "schoolManager" },
  });
  expect(tampered.body.data).toEqual(baseline.body.data);
  expect(tampered.body.data).toMatchObject({ roles: { schoolManager: false }, capabilities: { canEnterAdmin: false } });

  expect(await me(cookie, { query: "?actorId=" + encodeURIComponent(school.userId) }))
    .toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
  const post = await mePost(new Request(origin + "/api/v1/me", { method: "POST", headers: { Cookie: cookie } }), {});
  expect(post.status).toBe(405);
  expect(post.headers.get("Allow")).toBe("GET");
});

function entryRoute(userId: string) {
  const execute = vi.fn(async () => ({
    status: 200 as const, resource: { type: "user", id: userId }, version: 1, state: "updated",
  }));
  const route = defineApiRoute({
    PATCH: (_request, _context, input) => commitMutation(drizzle(pool), {
      actorId: userId, body: {}, request: input,
      authorizeEntry: authorizeActiveEntry(userId),
      authorizeReplay: async () => {},
      execute,
    }),
  }, { BETTER_AUTH_URL: origin });
  const send = () => route.PATCH(new Request(origin + "/api/v1/test", {
    method: "PATCH", body: "{}",
    headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  }), {});
  return { execute, send };
}

/** 別の接続が holderPid のロックを待ち始めるまで待つ。 */
async function waitUntilBlockedBy(holderPid: number) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const { rows: [row] } = await target.client.query<{ blocked: number }>(
      "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holderPid],
    );
    if (row.blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("更新が停止処理のロックを待つ状態になりませんでした。");
}

it("更新の入口確認は停止とロックで直列化され、停止確定後の更新を拒否する", async () => {
  const { userId } = await logIn("poc_a001");
  const holder = new Client({ connectionString: target.url.toString() });
  await holder.connect();
  try {
    const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await holder.query("BEGIN");
    await holder.query("UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1", [userId]);
    await holder.query(`
      INSERT INTO account_restrictions (user_id, actor_id, action, public_reason, internal_reason)
      VALUES ($1, $1, 'suspend', '理由', '内部理由')`, [userId]);

    const { execute, send } = entryRoute(userId);
    const pending = send();
    // 停止処理が実行者の行を保持している間、更新は入口確認の前の行ロックで待つ。
    await waitUntilBlockedBy(pid);
    await holder.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ACCOUNT_SUSPENDED");
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end();
  }
});

it("停止理由の記録が欠けていても業務APIは403で拒否し、/meだけが不整合を500にする", async () => {
  const { userId, cookie } = await logIn("poc_staff_mgr");
  await update("UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1", userId);

  const { execute, send } = entryRoute(userId);
  const response = await send();
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("ACCOUNT_SUSPENDED");
  expect(execute).not.toHaveBeenCalled();

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await me(cookie)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR", fields: [] } } });
  } finally {
    consoleError.mockRestore();
  }
});
