import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { GET, POST } from "../../src/app/api/auth/[...auth]/route";
import { GET as meGet } from "../../src/app/api/v1/me/route";
import { loginRateLimit } from "../../src/auth/login-rate-limit";
import { getAuthSession } from "../../src/auth/server";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const loginPath = "/sign-in/username";
const sessionPath = "/get-session";
const logoutPath = "/sign-out";
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));
// 上限の数え方は rate-limit-storage.test.ts で確認する。ここでは小さな上限で、
// HTTP入口の429・Retry-Afterへの変換と時間窓の解除までの配線を確認する。
vi.mock("../../src/auth/login-rate-limit", () => ({ loginRateLimit: { window: 60, max: 10 } }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString() });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-auth-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

async function send(path: string, {
  body, cookie, ip = "192.0.2.10", method = body === undefined ? "GET" : "POST", requestOrigin = origin,
}: { body?: object; cookie?: string; ip?: string; method?: string; requestOrigin?: string | null } = {}) {
  const headers = new Headers({ "X-Forwarded-For": ip });
  if (requestOrigin !== null) headers.set("Origin", requestOrigin);
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(origin + "/api/auth" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await (method === "GET" ? GET : POST)(request);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response;
}

async function logIn(username: string, ip?: string) {
  const response = await send(loginPath, { ip, body: { username, password: credentials[username] } });
  expect(response.status).toBe(200);
  const { rows: [user] } = await target.client.query<{ id: string }>(
    'SELECT id FROM "user" WHERE username = $1', [username],
  );
  expect(await response.json()).toEqual({ redirect: false, user: { id: user.id } });
  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="));
  expect(Boolean(sessionCookie)).toBe(true);
  for (const attribute of ["secure", "httponly", "samesite=lax"]) {
    expect(sessionCookie!.toLowerCase().split("; ").includes(attribute)).toBe(true);
  }
  return { userId: user.id, cookie: sessionCookie!.split(";", 1)[0] };
}

it("seedアカウントでログイン・セッション確認・ログアウトし、旧Cookieを拒否する", async () => {
  const { userId, cookie } = await logIn("poc_s001");
  const { rows: [stored] } = await target.client.query<{ created_at: Date; expires_at: Date }>(
    "SELECT created_at, expires_at FROM session WHERE user_id = $1", [userId],
  );
  expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBeCloseTo(8 * 60 * 60 * 1000, -2);
  const response = await send(sessionPath, { cookie });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    session: { expiresAt: stored.expires_at.toISOString() }, user: { id: userId },
  });
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect(await getAuthSession(new Headers({ Cookie: cookie }))).toEqual({
    session: { expiresAt: stored.expires_at }, user: { id: userId },
  });
  const { rows: [checked] } = await target.client.query<{ expires_at: Date }>(
    "SELECT expires_at FROM session WHERE user_id = $1", [userId],
  );
  expect(checked.expires_at).toEqual(stored.expires_at);

  const logout = await send(logoutPath, { cookie, body: {} });
  expect(logout.status).toBe(200);
  expect(await logout.json()).toEqual({ success: true });
  expect(logout.headers.getSetCookie().some((value) =>
    value.startsWith("__Secure-better-auth.session_token=;") && /max-age=0/i.test(value),
  )).toBe(true);
  expect((await target.client.query("SELECT 1 FROM session WHERE user_id = $1", [userId])).rowCount).toBe(0);
  const revoked = await send(sessionPath, { cookie });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toBeNull();
});

it("未認証・期限切れをnullとし、停止中の利用者はログアウトできる", async () => {
  const anonymous = await send(sessionPath);
  expect(anonymous.status).toBe(200);
  expect(await anonymous.json()).toBeNull();

  const active = await logIn("poc_s002");
  await target.client.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE user_id = $1", [active.userId]);
  const expired = await send(sessionPath, { cookie: active.cookie });
  expect(expired.status).toBe(200);
  expect(await expired.json()).toBeNull();

  const suspended = await logIn("poc_suspended");
  const logout = await send(logoutPath, { cookie: suspended.cookie, body: {} });
  expect(logout.status).toBe(200);
  expect(await logout.json()).toEqual({ success: true });
  expect((await target.client.query("SELECT 1 FROM session WHERE user_id = $1", [suspended.userId])).rowCount).toBe(0);
});

it.each(["連続", "同時"])("同一IPから異なる架空アカウントが4件%sログインできる", async (mode) => {
  const usernames = ["poc_school", "poc_s001", "poc_s002", "poc_staff"];
  if (mode === "同時") {
    await Promise.all(usernames.map((username) => logIn(username, "192.0.2.15")));
  } else {
    for (const username of usernames) await logIn(username, "192.0.2.14");
  }
});

it("資格情報の失敗を同一応答にし、同一IPで上限を超えると429を返し、時間窓が過ぎると解除する", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    await expectLoginLimit();
  } finally {
    vi.useRealTimers();
  }
});

async function expectLoginLimit() {
  const ip = "192.0.2.11";
  const wrongPassword = randomBytes(18).toString("hex");
  const missing = await send(loginPath, { ip, body: { username: "missing_id", password: wrongPassword } });
  const wrong = await send(loginPath, { ip, body: { username: "poc_s001", password: wrongPassword } });
  expect(missing.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(await missing.json()).toEqual(await wrong.json());
  expect(missing.headers.getSetCookie()).toHaveLength(0);
  expect(wrong.headers.getSetCookie()).toHaveLength(0);
  const body = { username: "missing_id", password: wrongPassword };
  for (let accepted = 2; accepted < loginRateLimit.max; accepted++) {
    expect((await send(loginPath, { ip, body })).status).toBe(401);
  }
  const limited = await send(loginPath, { ip, body });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(Number(limited.headers.get("Retry-After"))).toBeLessThanOrEqual(loginRateLimit.window);
  expect(limited.headers.getSetCookie()).toHaveLength(0);
  // 拒否した試行は上限+1で止める（rate-limit-storage.ts）。
  expect((await target.client.query(
    "SELECT 1 FROM rate_limit WHERE key LIKE $1 AND count = $2", ["%192.0.2.11%", loginRateLimit.max + 1],
  )).rowCount).toBe(1);

  // 別の送信元は制限されない。
  expect((await send(loginPath, { ip: "192.0.2.16", body })).status).toBe(401);

  // 時間窓の起点から60秒たつと、同じ送信元でも再び認証を試せる。
  vi.setSystemTime(Date.now() + loginRateLimit.window * 1000);
  expect((await send(loginPath, { ip, body })).status).toBe(401);
}

it("再発行後は旧パスワードと再発行前の全Cookieを認証APIで拒否し、新しいパスワードでログインできる", async () => {
  const username = "poc_a001";
  const ip = "192.0.2.17";
  const oldPassword = credentials[username];
  const first = await logIn(username, ip);
  const second = await logIn(username, ip);
  expect((await me(first.cookie)).status).toBe(200);

  const output = join(credentialsDir, "reset-poc_a001.json");
  const reset = spawnSync("npm", ["run", "account:reset-password", "--", "--username", username, "--output", output], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_URL_DIRECT: target.url.toString(),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    },
  });
  expect(reset.status).toBe(0);
  const { password: newPassword } = JSON.parse(await readFile(output, "utf8")) as { password: string };
  expect(newPassword).not.toBe(oldPassword);

  // 再発行前のセッションは、どのCookieでもセッション確認・保護APIの両方で未認証になる。
  for (const { cookie } of [first, second]) {
    const session = await send(sessionPath, { cookie });
    expect(session.status).toBe(200);
    expect(await session.json()).toBeNull();
    expect((await me(cookie)).status).toBe(401);
  }

  const rejected = await send(loginPath, { ip, body: { username, password: oldPassword } });
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toEqual({ code: "INVALID_USERNAME_OR_PASSWORD" });
  expect(rejected.headers.getSetCookie()).toHaveLength(0);

  credentials[username] = newPassword;
  const renewed = await logIn(username, ip);
  expect(renewed.userId).toBe(first.userId);
  expect((await me(renewed.cookie)).status).toBe(200);
}, 60_000); // 再発行コマンドを別プロセスで起動するため、既定の15秒より長くする。

/** 保護API（API-COM-01）の応答。認証されていなければ401になる。 */
async function me(cookie: string) {
  const response = await meGet(new Request(origin + "/api/v1/me", { headers: { Cookie: cookie } }), {});
  return { status: response.status };
}

it.each([null, "https://other.example", "https://school.example/"])(
  "Cookieのない初回ログインでも正規Originと完全一致しなければ拒否する (%s)",
  async (requestOrigin) => {
    const response = await send(loginPath, {
      requestOrigin, body: { username: "poc_s001", password: credentials.poc_s001 },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "ORIGIN_NOT_ALLOWED" });
    expect(response.headers.getSetCookie()).toHaveLength(0);
  },
);

it("セッションのDB削除が失敗したらCookieを保持し、復旧後に再試行できる", async () => {
  const { userId, cookie } = await logIn("poc_staff", "192.0.2.13");
  await target.client.query(`
    CREATE FUNCTION fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'simulated session delete failure';
    END;
    $$;
    CREATE TRIGGER fail_session_delete BEFORE DELETE ON session
    FOR EACH ROW EXECUTE FUNCTION fail_session_delete();
  `);
  try {
    const failed = await send(logoutPath, { cookie, body: {} });
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toHaveLength(0);
    expect((await getAuthSession(new Headers({ Cookie: cookie })))?.user.id).toBe(userId);
  } finally {
    await target.client.query("DROP TRIGGER fail_session_delete ON session; DROP FUNCTION fail_session_delete()");
  }

  const retried = await send(logoutPath, { cookie, body: {} });
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ success: true });
  expect(retried.headers.getSetCookie().some((value) =>
    value.startsWith("__Secure-better-auth.session_token=;") && /max-age=0/i.test(value),
  )).toBe(true);
  expect(await getAuthSession(new Headers({ Cookie: cookie }))).toBeNull();
});

it.each([
  ["POST", "/sign-up/email"],
  ["POST", "/sign-in/email"],
  ["POST", "/request-password-reset"],
  ["POST", "/update-user"],
  ["POST", "/get-session"],
  ["GET", loginPath],
  ["GET", logoutPath],
])("未公開の経路 %s %s を拒否する", async (method, path) => {
  const response = await send(path, { method, body: method === "POST" ? {} : undefined });
  expect(response.status).toBe(404);
  expect(response.headers.getSetCookie()).toHaveLength(0);
});

it("入力長違反とSDK独自のログインオプションを拒否する", async () => {
  const cases = [
    { username: "poc_s001", password: "short" },
    { username: "poc_s001", password: credentials.poc_s001, rememberMe: false },
    { username: "poc_s001", password: credentials.poc_s001, callbackURL: "/" },
  ];
  for (const body of cases) {
    const response = await send(loginPath, { body, ip: "192.0.2.12" });
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  }
});
