import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { defineAuthorizedApiRoute } from "../../src/api/authorized-route";
import { readJson } from "../../src/api/request";
import { POST as authPost } from "../../src/app/api/auth/[...auth]/route";
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
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-authorized-route-test-"));
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
      Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${++ipCounter}`,
    },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  return { userId: user.id, cookie };
}

function businessRoute() {
  const handled = vi.fn();
  const route = defineAuthorizedApiRoute({
    GET(_request, _context, viewer) {
      handled("GET", viewer.userId);
      return { data: { viewerId: viewer.userId, baseRole: viewer.baseRole } };
    },
    async POST(request, _context, viewer) {
      const body = await readJson(request, z.object({ actorId: z.string().optional(), message: z.string() }));
      handled("POST", viewer.userId);
      return { status: 201, data: { actorId: viewer.userId, message: body.message } };
    },
  }, { BETTER_AUTH_URL: origin });
  return { route, handled };
}

async function call(
  route: ReturnType<typeof businessRoute>["route"],
  method: "GET" | "POST",
  cookie?: string,
  body?: object,
) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (method === "POST") {
    headers.set("Origin", origin);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", randomUUID());
  }
  const response = await route[method](new Request(origin + "/api/v1/sample", {
    method, headers, body: method === "POST" ? JSON.stringify(body ?? { message: "本文" }) : undefined,
  }), {});
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return { status: response.status, body: await response.json() };
}

it("未認証・偽Cookie・失効セッションは処理を呼ばずに401 AUTH_REQUIRED を返す", async () => {
  const { route, handled } = businessRoute();
  for (const method of ["GET", "POST"] as const) {
    expect(await call(route, method)).toMatchObject({ status: 401, body: { error: { code: "AUTH_REQUIRED" } } });
    expect((await call(route, method, "__Secure-better-auth.session_token=forged.value")).status).toBe(401);
  }
  const { userId, cookie } = await logIn("poc_s001");
  await target.client.query("UPDATE session SET expires_at = now() - interval '1 second' WHERE user_id = $1", [userId]);
  expect((await call(route, "GET", cookie)).status).toBe(401);
  expect(handled).not.toHaveBeenCalled();
});

it("発行・学校確認未完了は403 ACCOUNT_NOT_READY とし、処理を呼ばない", async () => {
  const { route, handled } = businessRoute();
  const { userId, cookie } = await logIn("poc_staff");
  await target.client.query("UPDATE community_users SET eligibility_status = 'pending' WHERE user_id = $1", [userId]);
  try {
    for (const method of ["GET", "POST"] as const) {
      const response = await call(route, method, cookie);
      expect(response).toMatchObject({ status: 403, body: { error: { code: "ACCOUNT_NOT_READY" } } });
      expect(response.body.data).toBeUndefined();
    }
    expect(handled).not.toHaveBeenCalled();
  } finally {
    await target.client.query("UPDATE community_users SET eligibility_status = 'verified' WHERE user_id = $1", [userId]);
  }
});

it("停止中は403 ACCOUNT_SUSPENDED とし、停止理由や業務データを返さない", async () => {
  const { route, handled } = businessRoute();
  const { cookie } = await logIn("poc_suspended");
  for (const method of ["GET", "POST"] as const) {
    const response = await call(route, method, cookie);
    expect(response).toMatchObject({ status: 403, body: { error: { code: "ACCOUNT_SUSPENDED", fields: [] } } });
    expect(Object.keys(response.body).sort()).toEqual(["error", "meta"]);
  }
  expect(handled).not.toHaveBeenCalled();
});

it("利用中はセッションの利用者を処理に渡し、送信された actorId を使わない", async () => {
  const { route, handled } = businessRoute();
  const student = await logIn("poc_s002");
  const school = await logIn("poc_school");

  expect(await call(route, "GET", student.cookie)).toMatchObject({
    status: 200, body: { data: { viewerId: student.userId, baseRole: "student" } },
  });
  const posted = await call(route, "POST", student.cookie, { actorId: school.userId, message: "本文" });
  expect(posted).toMatchObject({ status: 201, body: { data: { actorId: student.userId, message: "本文" } } });
  expect(handled.mock.calls).toEqual([["GET", student.userId], ["POST", student.userId]]);
});

it("ログイン中に停止されたセッションは次の要求から拒否する", async () => {
  const { route } = businessRoute();
  const { userId, cookie } = await logIn("poc_a001");
  expect((await call(route, "GET", cookie)).status).toBe(200);
  await target.client.query("UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1", [userId]);
  expect(await call(route, "GET", cookie)).toMatchObject({ status: 403, body: { error: { code: "ACCOUNT_SUSPENDED" } } });
});

it("定義していないメソッドは405とし、Allow に定義済みのメソッドだけを示す", async () => {
  const { route } = businessRoute();
  const response = await route.PATCH(new Request(origin + "/api/v1/sample", { method: "PATCH" }), {});
  expect(response.status).toBe(405);
  expect(response.headers.get("Allow")).toBe("GET, POST");
});
