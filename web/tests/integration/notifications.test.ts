import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 通知の一覧・未読件数・既読（#17 ②、API-NT-01〜03）。実際の Route Handler を実セッションで呼ぶ。
 * AC-03：取得のみでは既読にならず、同じ通知を再度既読にしても既読時刻を上書きしない。
 * AC-04：停止中や他人の通知へのアクセスを拒否する。
 * SEC-04：在校生が通知の閲覧を経由して他人の実名にアクセスできない。
 */

const origin = "https://school.example";
/** このテストが追加する通知の event_key に付ける接頭辞。テストごとに消す。 */
const keyPrefix = "test-notification:";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let listRoute: typeof import("../../src/app/api/v1/notifications/route");
let countRoute: typeof import("../../src/app/api/v1/notifications/unread-count/route");
let readRoute: typeof import("../../src/app/api/v1/notifications/[notificationId]/read/route");
let ipCounter = 0;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-notifications-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user" WHERE username IS NOT NULL');
  for (const { id, username } of rows) ids.set(username, id);
  // seed の通知は、件数・並び順の確認に影響しないよう、このテストの間だけ外す。
  await target.client.query("UPDATE notifications SET read_at = created_at WHERE read_at IS NULL");
  listRoute = await import("../../src/app/api/v1/notifications/route");
  countRoute = await import("../../src/app/api/v1/notifications/unread-count/route");
  readRoute = await import("../../src/app/api/v1/notifications/[notificationId]/read/route");
});

afterEach(async () => {
  await target.client.query("DELETE FROM operation_receipts WHERE result_type = 'notification'");
  await target.client.query("DELETE FROM notifications WHERE event_key LIKE $1", [`${keyPrefix}%`]);
  await target.client.query("UPDATE community_users SET account_status = 'active' WHERE user_id = $1", [id("poc_s002")]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

function id(username: string): string {
  const value = ids.get(username);
  if (!value) throw new Error(`${username} がありません`);
  return value;
}

async function cookieFor(username: string) {
  const cached = cookies.get(username);
  if (cached) return cached;
  const { POST } = await import("../../src/app/api/auth/[...auth]/route");
  const response = await POST(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${++ipCounter}` },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  cookies.set(username, cookie);
  return cookie;
}

type Item = { id: string; kind: string; message: string; createdAt: string; readAt: string | null };
type Body = {
  data?: { items?: Item[]; count?: number; operationId?: string; resource?: { type: string; id: string };
    version?: number | null; state?: string; committedAt?: string };
  error?: { code: string };
  meta: { replayed?: true; page?: { totalCount: number; hasMore: boolean; nextCursor: string | null; limit: number } };
};

async function result(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text, headers: response.headers };
}

async function headersFor(viewer: string | null): Promise<Record<string, string>> {
  return viewer ? { Cookie: await cookieFor(viewer) } : {};
}

async function list(viewer: string | null, query: Record<string, string> | string = {}) {
  const url = `${origin}/api/v1/notifications?${new URLSearchParams(query)}`;
  return result(await listRoute.GET(new Request(url, { headers: await headersFor(viewer) }), {}));
}

async function unreadCount(viewer: string | null, search = "") {
  return result(await countRoute.GET(
    new Request(`${origin}/api/v1/notifications/unread-count${search}`, { headers: await headersFor(viewer) }), {}));
}

async function markRead(viewer: string | null, notificationId: string, options: {
  key?: string; body?: string; headers?: Record<string, string>;
} = {}) {
  return result(await readRoute.POST(new Request(`${origin}/api/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: "POST",
    headers: {
      Origin: origin, "Content-Type": "application/json", "Idempotency-Key": options.key ?? `read-${randomUUID()}`,
      ...await headersFor(viewer), ...options.headers,
    },
    body: options.body ?? "{}",
  }), { params: Promise.resolve({ notificationId }) }));
}

type NewNotification = { at: string; read?: string; kind?: "profile_hidden" | "qa_hidden"; message?: string };

/**
 * 受信者に通知を作り、渡した順にIDを返す。対象は受信者本人のプロフィール（profile_hidden）にして、
 * ほかのテーブルに依存させない。作成日時は渡した値にする。
 */
async function addNotifications(recipient: string, notifications: NewNotification[]): Promise<string[]> {
  const created: string[] = [];
  for (const notification of notifications) {
    const { rows } = await target.client.query<{ id: string }>(`
      INSERT INTO notifications (recipient_id, kind, profile_user_id, event_key, public_message, read_at, created_at)
      VALUES ($1, 'profile_hidden', $1, $2, $3, $4, $5) RETURNING id
    `, [id(recipient), `${keyPrefix}${randomUUID()}`, notification.message ?? "プロフィールが管理者により非表示になりました。\n理由：確認のため",
      notification.read ?? null, notification.at]);
    created.push(rows[0].id);
  }
  return created;
}

async function readAtOf(notificationId: string): Promise<Date | null> {
  const { rows } = await target.client.query<{ read_at: Date | null }>("SELECT read_at FROM notifications WHERE id = $1", [notificationId]);
  return rows[0].read_at;
}

const itemIds = (body: Body) => (body.data?.items ?? []).map((item) => item.id);

/** このテストのDBで、行ロックを待っている接続が現れるまで待つ（`commitMutation` の lock_timeout は2秒）。 */
async function waitForLockWait() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await target.client.query<{ waiting: number }>(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (rows[0].waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("行ロックを待つ接続が現れませんでした。");
}

describe("AC-04：停止中・未認証の利用者と、他人の通知へのアクセスを拒否する", () => {
  it("AC-04 未認証は401、停止中は403とし、通知の内容・件数を返さず既読にしない", async () => {
    const [suspendedOwn] = await addNotifications("poc_suspended", [{ at: "2026-11-20T00:00:00Z", message: "停止中の利用者宛ての秘密" }]);
    for (const [viewer, status, code] of [[null, 401, "AUTH_REQUIRED"], ["poc_suspended", 403, "ACCOUNT_SUSPENDED"]] as const) {
      for (const response of [await list(viewer), await unreadCount(viewer), await markRead(viewer, suspendedOwn)]) {
        expect({ status: response.status, code: response.body.error?.code }).toEqual({ status, code });
        expect(Object.keys(response.body).sort()).toEqual(["error", "meta"]);
        expect(response.text).not.toContain("停止中の利用者宛ての秘密");
        expect(response.text).not.toContain(suspendedOwn);
      }
    }
    expect(await readAtOf(suspendedOwn)).toBeNull();
  });

  it("AC-04 処理中に停止された利用者の既読は、行ロック後の確認で拒否する", async () => {
    const [own] = await addNotifications("poc_s002", [{ at: "2026-11-20T00:00:00Z" }]);
    await cookieFor("poc_s002");
    // Route Handler の入口の確認を通った後に停止された場合と同じ状態を、DBの更新を遅らせて作る。
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM community_users WHERE user_id = $1 FOR UPDATE", [id("poc_s002")]);
      const pending = markRead("poc_s002", own);
      // 既読の操作が利用者の行ロックを待ち始めてから停止する（入口の確認は通過済み）。
      await waitForLockWait();
      await client.query("UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1", [id("poc_s002")]);
      await client.query("COMMIT");
      const response = await pending;
      expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 403, code: "ACCOUNT_SUSPENDED" });
    } finally {
      client.release();
    }
    expect(await readAtOf(own)).toBeNull();
  });

  it("AC-04 他人の通知は一覧・件数に含めず、既読にしようとしても存在しない通知と同じ404にする", async () => {
    const [others] = await addNotifications("poc_s001", [{ at: "2026-11-20T00:00:00Z", message: "はる宛ての秘密" }]);
    const [own] = await addNotifications("poc_s002", [{ at: "2026-11-19T00:00:00Z" }]);

    const listed = await list("poc_s002");
    expect(itemIds(listed.body)).toEqual([own]);
    expect(listed.body.meta.page?.totalCount).toBe(1);
    expect(listed.text).not.toContain("はる宛ての秘密");
    expect((await unreadCount("poc_s002")).body.data).toEqual({ count: 1 });

    const missing = randomUUID();
    for (const notificationId of [others, missing]) {
      const response = await markRead("poc_s002", notificationId);
      expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 404, code: "NOT_FOUND" });
      expect(Object.keys(response.body).sort()).toEqual(["error", "meta"]);
      expect(response.text).not.toContain("はる宛ての秘密");
    }
    expect(await readAtOf(others)).toBeNull();
    expect((await unreadCount("poc_s001")).body.data).toEqual({ count: 1 });
  });

  it("AC-04 同じ再送キーでも、他人の通知の既読は確定しない", async () => {
    const [others] = await addNotifications("poc_s001", [{ at: "2026-11-20T00:00:00Z" }]);
    const key = `read-${randomUUID()}`;
    expect((await markRead("poc_s002", others, { key })).status).toBe(404);
    expect((await markRead("poc_s002", others, { key })).status).toBe(404);
    expect(await readAtOf(others)).toBeNull();
    const { rows } = await target.client.query("SELECT 1 FROM operation_receipts WHERE request_key = $1", [key]);
    expect(rows).toHaveLength(0);
  });
});

describe("API-NT-01 通知一覧", () => {
  it("本人の通知を作成日時の降順・IDの降順で返し、DTOの項目だけを返す", async () => {
    const [older, sameA, sameB, newest] = await addNotifications("poc_s002", [
      { at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" },
      { at: "2026-11-03T00:00:00Z", read: "2026-11-03T01:00:00Z" },
    ]);
    const { status, body, headers } = await list("poc_s002");
    expect(status).toBe(200);
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    const [high, low] = [sameA, sameB].sort().reverse();
    expect(itemIds(body)).toEqual([newest, high, low, older]);
    expect(body.data?.items?.[0]).toEqual({
      id: newest, kind: "profile_hidden", message: "プロフィールが管理者により非表示になりました。\n理由：確認のため",
      createdAt: "2026-11-03T00:00:00.000Z", readAt: "2026-11-03T01:00:00.000Z",
    });
    expect(body.data?.items?.[1].readAt).toBeNull();
    expect(body.meta.page).toEqual({ limit: 20, hasMore: false, nextCursor: null, totalCount: 4 });
  });

  it("state=unread で未読だけに絞り込み、件数にも同じ条件を適用する", async () => {
    const [unreadOld, , unreadNew] = await addNotifications("poc_s002", [
      { at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z", read: "2026-11-02T01:00:00Z" }, { at: "2026-11-03T00:00:00Z" },
    ]);
    const { body } = await list("poc_s002", { state: "unread" });
    expect(itemIds(body)).toEqual([unreadNew, unreadOld]);
    expect(body.meta.page?.totalCount).toBe(2);
    expect((await list("poc_s002", { state: "all" })).body.meta.page?.totalCount).toBe(3);
  });

  it("同じ作成日時の通知もページの境目で抜けず、重ならない", async () => {
    // マイクロ秒だけ違う作成日時（Date を経由するとミリ秒に丸められる）と、同じ作成日時を混ぜる。
    const created = await addNotifications("poc_s002", [
      { at: "2026-11-02T00:00:00.000001Z" }, { at: "2026-11-02T00:00:00.000002Z" }, { at: "2026-11-02T00:00:00.000002Z" },
      { at: "2026-11-02T00:00:00.000003Z" }, { at: "2026-11-02T00:00:00.000003Z" },
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list("poc_s002", { limit: "2", ...cursor ? { cursor } : {} });
      expect(page.status).toBe(200);
      expect(page.body.meta.page?.totalCount).toBe(5);
      seen.push(...itemIds(page.body));
      cursor = page.body.meta.page?.nextCursor ?? null;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it("カーソルは閲覧者と絞り込みにひも付け、ほかの条件・利用者では使えない", async () => {
    await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }]);
    await addNotifications("poc_s001", [{ at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }]);
    const cursor = (await list("poc_s002", { limit: "1" })).body.meta.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    for (const response of [
      await list("poc_s002", { limit: "1", state: "unread", cursor: cursor! }),
      await list("poc_s001", { limit: "1", cursor: cursor! }),
      await list("poc_s002", { cursor: "invalid" }),
    ]) {
      expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 400, code: "INVALID_CURSOR" });
    }
  });

  it.each([
    ["state=read"], ["state=all&state=unread"], ["limit=0"], ["limit=51"], ["kind=qa_hidden"],
  ])("未定義の条件 %s は400にする", async (query) => {
    const response = await list("poc_s002", query);
    expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
});

describe("API-NT-02 未読件数", () => {
  it("本人の未読だけを数え、クエリーは受け付けない", async () => {
    await addNotifications("poc_s002", [
      { at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }, { at: "2026-11-03T00:00:00Z", read: "2026-11-03T01:00:00Z" },
    ]);
    await addNotifications("poc_s001", [{ at: "2026-11-01T00:00:00Z" }]);
    const { status, body, headers } = await unreadCount("poc_s002");
    expect({ status, data: body.data }).toEqual({ status: 200, data: { count: 2 } });
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect((await unreadCount("poc_a001")).body.data).toEqual({ count: 0 });
    expect((await unreadCount("poc_s002", "?state=unread")).status).toBe(400);
  });
});

describe("AC-03：取得のみでは既読にならず、同じ通知を再度既読にしても既読時刻を上書きしない", () => {
  it("AC-03 一覧・件数を取得しても既読にならない", async () => {
    const [notificationId] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }]);
    await list("poc_s002");
    await list("poc_s002", { state: "unread" });
    await unreadCount("poc_s002");
    expect(await readAtOf(notificationId)).toBeNull();
    expect((await list("poc_s002")).body.data?.items?.[0].readAt).toBeNull();
  });

  it("AC-03 既読にすると既読時刻を設定し、別の操作で再度既読にしても最初の既読時刻を変えない", async () => {
    const [notificationId, other] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }]);
    const first = await markRead("poc_s002", notificationId);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      operationId: expect.any(String), resource: { type: "notification", id: notificationId }, version: null, state: "read",
      committedAt: expect.any(String),
    });
    const readAt = await readAtOf(notificationId);
    expect(readAt?.toISOString()).toBe(first.body.data?.committedAt);
    expect(await readAtOf(other)).toBeNull();
    expect((await unreadCount("poc_s002")).body.data).toEqual({ count: 1 });
    expect((await list("poc_s002", { state: "unread" })).body.data?.items?.map((item) => item.id)).toEqual([other]);

    const again = await markRead("poc_s002", notificationId);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ resource: { type: "notification", id: notificationId }, version: null, state: "read" });
    expect(again.body.data?.operationId).not.toBe(first.body.data?.operationId);
    expect(again.body.meta.replayed).toBeUndefined();
    expect(await readAtOf(notificationId)).toEqual(readAt);
    expect((await list("poc_s002")).body.data?.items?.find((item) => item.id === notificationId)?.readAt).toBe(readAt?.toISOString());
  });

  it("AC-03 同じ再送キーの再送は、最初の結果を返し、既読時刻を変えない", async () => {
    const [notificationId, other] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }, { at: "2026-11-02T00:00:00Z" }]);
    const key = `read-${randomUUID()}`;
    const first = await markRead("poc_s002", notificationId, { key });
    const readAt = await readAtOf(notificationId);
    const replay = await markRead("poc_s002", notificationId, { key });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(replay.body.meta.replayed).toBe(true);
    expect(await readAtOf(notificationId)).toEqual(readAt);

    // 同じ再送キーを別の通知に使った場合は、別の操作として拒否する。
    const reused = await markRead("poc_s002", other, { key });
    expect({ status: reused.status, code: reused.body.error?.code }).toEqual({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await readAtOf(other)).toBeNull();
  });

  it("AC-03 再送時も現在の利用資格を確認し、停止中は確定済みの結果も返さない", async () => {
    const [notificationId] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }]);
    const key = `read-${randomUUID()}`;
    expect((await markRead("poc_s002", notificationId, { key })).status).toBe(200);
    await target.client.query("UPDATE community_users SET account_status = 'suspended' WHERE user_id = $1", [id("poc_s002")]);
    const replay = await markRead("poc_s002", notificationId, { key });
    expect({ status: replay.status, code: replay.body.error?.code }).toEqual({ status: 403, code: "ACCOUNT_SUSPENDED" });
    expect(replay.text).not.toContain(notificationId);
  });

  it("AC-03 同時に既読にしても両方とも成功し、先に確定した操作の既読時刻だけが残る", async () => {
    const [notificationId] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }]);
    await cookieFor("poc_s002");
    const responses = await Promise.all([markRead("poc_s002", notificationId), markRead("poc_s002", notificationId)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const committed = responses.map((response) => response.body.data!.committedAt!).sort();
    expect((await readAtOf(notificationId))?.toISOString()).toBe(committed[0]);
  });

  it("プロフィール非表示中の本人も既読にできる", async () => {
    const [notificationId] = await addNotifications("poc_hidden", [{ at: "2026-11-01T00:00:00Z" }]);
    expect((await markRead("poc_hidden", notificationId)).status).toBe(200);
    expect(await readAtOf(notificationId)).not.toBeNull();
  });

  it.each([
    ["本文に項目がある", { body: JSON.stringify({ read: true }) }, 422, "VALIDATION_FAILED"],
    ["本文がJSONでない", { body: "read" }, 400, "BAD_REQUEST"],
    ["再送キーがない", { headers: { "Idempotency-Key": "" } }, 400, "BAD_REQUEST"],
    ["JSON以外の本文", { headers: { "Content-Type": "text/plain" } }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["許可していないOrigin", { headers: { Origin: "https://evil.example" } }, 403, "ORIGIN_NOT_ALLOWED"],
  ] as const)("%s場合は拒否し、既読にしない", async (_label, options, status, code) => {
    const [notificationId] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }]);
    const response = await markRead("poc_s002", notificationId, options);
    expect({ status: response.status, code: response.body.error?.code }).toEqual({ status, code });
    expect(await readAtOf(notificationId)).toBeNull();
  });

  it("通知IDの形式が誤っている場合は400にする", async () => {
    const response = await markRead("poc_s002", "not-a-uuid");
    expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  it("一覧・件数のAPIは既読の操作を受け付けず、既読のAPIは取得を受け付けない", async () => {
    const [notificationId] = await addNotifications("poc_s002", [{ at: "2026-11-01T00:00:00Z" }]);
    const post = await listRoute.POST(new Request(`${origin}/api/v1/notifications`, { method: "POST" }), {});
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toContain("GET");
    const get = await readRoute.GET(new Request(`${origin}/api/v1/notifications/${notificationId}/read`), {
      params: Promise.resolve({ notificationId }),
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    expect(await readAtOf(notificationId)).toBeNull();
  });
});

describe("SEC-04：在校生が通知の閲覧を経由して他人の実名にアクセスできない", () => {
  it("SEC-04 他人の操作で作られた通知でも、操作者の実名・ID・表示名を返さない", async () => {
    // seed の在校生宛ての回答通知（卒業生の回答）を未読に戻して確認する。
    await target.client.query("UPDATE notifications SET read_at = NULL WHERE recipient_id = $1 AND kind = 'qa_answer_created'", [id("poc_s001")]);
    try {
      const { status, body, text } = await list("poc_s001");
      expect(status).toBe(200);
      expect(body.data?.items?.map((item) => item.kind)).toContain("qa_answer_created");
      for (const item of body.data?.items ?? []) expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "kind", "message", "readAt"]);
      const { rows } = await target.client.query<{ name: string }>("SELECT private_real_name AS name FROM identity_records");
      expect(rows.length).toBeGreaterThan(0);
      for (const { name } of rows) expect(text).not.toContain(name);
      for (const secret of [id("poc_a001"), "あおい", id("poc_s001")]) expect(text).not.toContain(secret);
    } finally {
      await target.client.query("UPDATE notifications SET read_at = created_at WHERE recipient_id = $1 AND read_at IS NULL", [id("poc_s001")]);
    }
  });
});
