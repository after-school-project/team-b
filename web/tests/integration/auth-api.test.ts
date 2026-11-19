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
import { getAuthSession } from "../../src/auth/server";
import { isolatedDatabase } from "./isolated-database";

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
  await pool?.end();
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

it("資格情報の失敗を同一応答にし、同一IPの31件目はRetry-After付きの429を返す", async () => {
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
  for (let accepted = 2; accepted < 30; accepted++) {
    expect((await send(loginPath, { ip, body })).status).toBe(401);
  }
  const limited = await send(loginPath, { ip, body });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  expect(limited.headers.getSetCookie()).toHaveLength(0);
  expect((await target.client.query(
    "SELECT 1 FROM rate_limit WHERE key LIKE $1 AND count = 30", ["%192.0.2.11%"],
  )).rowCount).toBe(1);
});

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
