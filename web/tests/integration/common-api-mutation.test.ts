import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertExpectedVersion, commitMutation } from "../../src/api/mutation";
import { expectedVersion, readJson, title, type MutationRequest } from "../../src/api/request";
import { ApiError } from "../../src/api/response";
import { defineApiRoute } from "../../src/api/route";
import * as auth from "../../src/db/auth-schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";
import * as community from "../../src/db/schema";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { isolatedDatabase } from "./isolated-database";

const { communityUsers, profiles, profileRevisions } = community;
const { auditLogs, notifications, operationReceipts } = moderation;
const schema = { ...auth, ...content, ...community, ...moderation };
const requestSchema = z.strictObject({ expectedVersion, message: title });
const origin = "https://school.example";
const defaultBody = { expectedVersion: 1, message: "変更" };
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let actor: string;
let secondActor: string;
let owner: string;

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  db = drizzle(pool, { schema });
});

beforeEach(async () => {
  [actor, secondActor, owner] = Array.from({ length: 3 }, () => randomUUID());
  await db.insert(auth.user).values([actor, secondActor, owner].map((id) => ({
    id, name: "テスト利用者", email: id + "@example.invalid",
  })));
  await db.insert(communityUsers).values([actor, secondActor, owner].map<typeof communityUsers.$inferInsert>((userId) => ({
    userId, baseRole: "student", eligibilityStatus: "verified", provisioningStatus: "ready",
  })));
  const [initial] = await db.insert(profileRevisions).values({
    userId: owner, revisionNo: 1, displayName: "初期表示名",
  }).returning({ id: profileRevisions.id });
  await db.insert(profiles).values({ userId: owner, currentRevisionId: initial.id });
});

afterAll(async () => {
  await pool?.end();
  await target?.dispose();
});

function mutationRoute(actorId = actor, options: { rollback?: boolean; discoverUser?: boolean } = {}) {
  const update = async (request: Request, _context: unknown, input: MutationRequest) => {
    const body = await readJson(request, requestSchema);
    return commitMutation(db, {
      actorId, body, request: input,
      resolveUserIds: async () => options.discoverUser ? [] : [owner],
      async authorizeEntry(tx) {
        const [user] = await tx.select().from(communityUsers).where(eq(communityUsers.userId, actorId));
        if (user.accountStatus === "suspended") throw new ApiError("ACCOUNT_SUSPENDED");
      },
      async targets(_tx, replayResource) {
        return [{ stage: "resource", table: profiles, idColumn: profiles.userId, ids: [replayResource?.id ?? owner] }];
      },
      async authorizeReplay({ tx, requireLockedUsers }, original) {
        requireLockedUsers(original.resource.id);
        const [user] = await tx.select().from(communityUsers).where(eq(communityUsers.userId, original.resource.id));
        if (user?.profileState !== "public") throw new ApiError("NOT_FOUND");
      },
      async execute({ tx, now, requireLockedUsers }) {
        requireLockedUsers(owner);
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, owner));
        assertExpectedVersion(profile.version, body.expectedVersion);
        const version = profile.version + 1;
        await tx.update(profiles).set({ version }).where(eq(profiles.userId, owner));
        await tx.insert(notifications).values({
          recipientId: owner, kind: "profile_hidden", profileUserId: owner,
          eventKey: String(version), publicMessage: body.message, createdAt: now,
        });
        await tx.insert(auditLogs).values({
          actorId, actionType: "test", targetType: "profile", targetId: owner, createdAt: now,
        });
        if (options.rollback) throw new Error("fixture failure");
        return { status: input.method === "POST" ? 201 : 200, resource: { type: "profile", id: owner },
          version, state: "updated" };
      },
    });
  };
  return defineApiRoute({ POST: update, PATCH: update }, { BETTER_AUTH_URL: origin });
}

function send(
  route: ReturnType<typeof mutationRoute>,
  { method = "PATCH", body = defaultBody, key = "mutation-key", path = "/api/v1/profiles" }:
    { method?: "POST" | "PATCH"; body?: typeof defaultBody; key?: string; path?: string } = {},
) {
  return route[method](new Request(origin + path, {
    method, body: JSON.stringify(body),
    headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key },
  }), {});
}

async function saved() {
  const [[profile], receipt, notices, audit] = await Promise.all([
    db.select({ version: profiles.version }).from(profiles).where(eq(profiles.userId, owner)),
    db.select().from(operationReceipts).where(eq(operationReceipts.resultId, owner)),
    db.select().from(notifications).where(eq(notifications.recipientId, owner)),
    db.select().from(auditLogs).where(eq(auditLogs.targetId, owner)),
  ]);
  return { version: profile.version, receipt, notices, audit };
}

it("並行した同じ操作とその後の再送を一度だけ確定し、元の201と結果を返す", async () => {
  const route = mutationRoute();
  const first = send(route, { method: "POST", body: { message: " 変更 ", expectedVersion: 1 } });
  const second = send(route, { method: "POST" });
  const responses = await Promise.all([first, second]);
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(responses.map(({ status }) => status)).toEqual([201, 201]);
  expect(results.filter((result) => result.meta.replayed === true)).toHaveLength(1);
  const later = await send(route, { method: "POST", path: "/api/v1/%70rofiles" });
  expect(later.status).toBe(201);
  const repeated = await later.json();
  expect(repeated.meta.replayed).toBe(true);
  expect(repeated.data).toEqual(results[0].data);
  expect(results[1].data).toEqual(results[0].data);
  expect(new Set([...results, repeated].map(({ meta }) => meta.requestId)).size).toBe(3);

  const rows = await saved();
  expect(rows.version).toBe(2);
  for (const items of [rows.receipt, rows.notices, rows.audit]) {
    expect(items).toHaveLength(1);
    expect(items[0].createdAt.toISOString()).toBe(repeated.data.committedAt);
  }
  expect(rows.receipt[0].id).toBe(repeated.data.operationId);
});

it("同じ操作者のキーを別本文・別メソッド・別パスに使うと409になり、別操作者は利用できる", async () => {
  const route = mutationRoute();
  expect((await send(route)).status).toBe(200);
  for (const change of [
    { body: { expectedVersion: 2, message: "別の本文" } },
    { method: "POST" as const }, { path: "/api/v1/another" },
  ]) {
    const response = await send(route, change);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  }
  const response = await send(mutationRoute(secondActor), { body: { expectedVersion: 2, message: "次の変更" } });
  expect(response.status).toBe(200);
  expect((await saved()).receipt).toHaveLength(2);
});

it("別操作者が同じ版を同時に更新すると片方だけ確定する", async () => {
  const responses = await Promise.all([send(mutationRoute()), send(mutationRoute(secondActor))]);
  expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
  const conflict = responses.find(({ status }) => status === 409)!;
  expect((await conflict.json()).error.code).toBe("VERSION_CONFLICT");
  const rows = await saved();
  expect(rows.version).toBe(2);
  for (const items of [rows.receipt, rows.notices, rows.audit]) expect(items).toHaveLength(1);
});

it("現在の入口資格と対象の閲覧権限を再送時にも適用する", async () => {
  const route = mutationRoute();
  expect((await send(route)).status).toBe(200);
  await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, owner));
  const hidden = await send(route);
  expect(hidden.status).toBe(404);
  expect((await hidden.json()).error.code).toBe("NOT_FOUND");
  await db.update(communityUsers).set({ accountStatus: "suspended" }).where(eq(communityUsers.userId, actor));
  const suspended = await send(route, { method: "POST" });
  expect(suspended.status).toBe(403);
  expect((await suspended.json()).error.code).toBe("ACCOUNT_SUSPENDED");
  expect((await saved()).receipt).toHaveLength(1);
});

it("途中で失敗した更新・通知・監査・操作記録をすべて取り消し、同じキーで再試行できる", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = await send(mutationRoute(actor, { rollback: true }));
  expect(failure.status).toBe(500);
  expect(await saved()).toEqual({ version: 1, receipt: [], notices: [], audit: [] });
  expect((await send(mutationRoute(actor, { discoverUser: true }))).status).toBe(200);
  expect((await saved()).version).toBe(2);
});

it("操作記録の保存に失敗した場合も先に書き込んだ業務変更を取り消す", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await target.client.query(
    "ALTER TABLE operation_receipts ADD CONSTRAINT reject_test_key CHECK (request_key <> 'db-rejected-key')",
  );
  try {
    const response = await send(mutationRoute(), { key: "db-rejected-key" });
    expect(response.status).toBe(500);
    expect(await saved()).toEqual({ version: 1, receipt: [], notices: [], audit: [] });
  } finally {
    await target.client.query("ALTER TABLE operation_receipts DROP CONSTRAINT reject_test_key");
  }
  expect((await send(mutationRoute(), { key: "db-rejected-key" })).status).toBe(200);
});

it("ロックの待機上限を503に変換し、解除後の再試行で確定する", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const blocker = await pool.connect();
  const route = mutationRoute();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT user_id FROM profiles WHERE user_id = $1 FOR UPDATE", [owner]);
    const response = await send(route);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("TEMPORARILY_UNAVAILABLE");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  expect(await saved()).toEqual({ version: 1, receipt: [], notices: [], audit: [] });
  const { rows: [time] } = await target.client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const response = await send(route);
  expect(response.status).toBe(200);
  expect(Date.parse((await response.json()).data.committedAt)).toBeGreaterThanOrEqual(time.now.getTime());
});
