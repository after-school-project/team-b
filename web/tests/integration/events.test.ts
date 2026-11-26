import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import type { EventListItem } from "../../src/events/event-list";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const authorName = "OnlyInAuthor";
const venue = "OnlyInVenue";
const externalUrl = "https://example.test/OnlyInUrl";
const signingSecret = randomBytes(32).toString("hex");
let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let authorId: string;
let viewerId: string;
let cookie: string;
let authorCookie: string;
let route: typeof import("../../src/app/api/v1/events/route");

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", signingSecret);
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-events-test-"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  const credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8")) as Record<string, string>;
  const { POST } = await import("../../src/app/api/auth/[...auth]/route");
  async function signIn(username: string, ip: string) {
    const response = await POST(new Request(origin + "/api/auth/sign-in/username", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ username, password: credentials[username] }),
    }));
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  }
  const { rows } = await target.client.query<{ id: string; username: string }>(
    'SELECT id, username FROM "user" WHERE username IN ($1, $2)', ["poc_s001", "poc_s002"],
  );
  authorId = rows.find(({ username }) => username === "poc_s001")!.id;
  viewerId = rows.find(({ username }) => username === "poc_s002")!.id;
  await target.client.query('UPDATE "user" SET name = $1 WHERE id = $2', [authorName, authorId]);
  await target.client.query("UPDATE profile_revisions SET display_name = $1 WHERE user_id = $2", [authorName, authorId]);
  cookie = await signIn("poc_s002", "203.0.113.1");
  authorCookie = await signIn("poc_s001", "203.0.113.2");
  route = await import("../../src/app/api/v1/events/route");
});

beforeEach(async () => {
  await target.client.query("TRUNCATE events, event_revisions, event_requests, notifications");
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

type Body = {
  data?: { items: EventListItem[] };
  error?: { code: string };
  meta: { page?: { totalCount: number; limit: number; hasMore: boolean; nextCursor: string | null } };
};

async function get(query: Record<string, string> | string = {}, session = cookie) {
  const response = await route.GET(new Request(`${origin}/api/v1/events?${new URLSearchParams(query)}`, {
    headers: { Cookie: session },
  }), {});
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

type Fixture = {
  title?: string; description?: string; startsAt?: string; endsAt?: string; createdAt?: string;
  hidden?: boolean; cancelled?: boolean; unpublished?: boolean; pendingEdit?: boolean;
};

async function addEvent(fixture: Fixture = {}) {
  const { rows: [event] } = await target.client.query<{ id: string }>(`
    INSERT INTO events (author_id, origin_kind, created_at, forced_hidden_at, cancelled_at)
    VALUES ($1, 'student', coalesce($2::timestamptz, now()), CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END)
    RETURNING id`, [authorId, fixture.createdAt ?? null, fixture.hidden ?? false, fixture.cancelled ?? false]);
  const { rows: [revision] } = await target.client.query<{ id: string }>(`
    INSERT INTO event_revisions (event_id, revision_no, title, description, starts_at, ends_at, format, venue, external_url)
    VALUES ($1, 1, $2, $3, $4, $5, 'in_person', $6, $7) RETURNING id`,
  [event.id, fixture.title ?? "公開題名", fixture.description ?? "公開本文", fixture.startsAt ?? "2026-11-25T16:00:00Z",
    fixture.endsAt ?? null, venue, externalUrl]);
  if (!fixture.unpublished) {
    await target.client.query("UPDATE events SET public_revision_id = $2, first_published_at = now() WHERE id = $1", [event.id, revision.id]);
  }
  if (fixture.pendingEdit) {
    const { rows: [edit] } = await target.client.query<{ id: string }>(`
      INSERT INTO event_revisions (event_id, revision_no, title, description, starts_at, format)
      VALUES ($1, 2, 'PendingTitle', 'PendingBody', '2099-01-01T00:00:00Z', 'online') RETURNING id`, [event.id]);
    await target.client.query("INSERT INTO event_requests (event_id, revision_id, request_kind) VALUES ($1, $2, 'edit')", [event.id, edit.id]);
  }
  return event.id;
}

it("AC-01 公開版だけを一覧・件数に含め、編集中も旧公開版のDTOを返す", async () => {
  const id = await addEvent({ pendingEdit: true, createdAt: "2026-11-01T00:00:00Z" });
  const hidden = await addEvent({ title: "HiddenTitle", hidden: true });
  const unpublished = await addEvent({ title: "DraftTitle", unpublished: true });
  for (const session of [cookie, authorCookie]) {
    const { status, body, text } = await get({}, session);
    expect(status).toBe(200);
    expect(body.data?.items).toEqual([{
      id, title: "公開題名", startsAt: "2026-11-25T16:00:00.000Z", effectiveEndsAt: "2026-11-26T15:00:00.000Z",
      format: "in_person", holdingState: expect.stringMatching(/^(scheduled|ended)$/), originKind: "student",
      createdAt: "2026-11-01T00:00:00.000Z",
    }]);
    expect(body.meta.page).toEqual({ totalCount: 1, limit: 20, hasMore: false, nextCursor: null });
    for (const withheld of [hidden, unpublished, "PendingTitle", "PendingBody", "公開本文", venue, externalUrl, authorId, authorName]) {
      expect(text).not.toContain(withheld);
    }
  }
});

it("公開版のタイトル・本文だけを大文字小文字を区別せず部分一致検索する", async () => {
  const title = await addEvent({ title: "React 入門", pendingEdit: true });
  const description = await addEvent({ description: "実践REACT講座" });
  const literal = await addEvent({ title: "進捗100%_完了" });
  await addEvent({ title: "React 非表示", hidden: true });
  await addEvent({ title: "React 未公開", unpublished: true });
  const { body } = await get({ q: " ReAcT " });
  expect(body.data?.items.map((item) => item.id).sort()).toEqual([title, description].sort());
  expect(body.meta.page?.totalCount).toBe(2);
  expect((await get({ q: "%_" })).body.data?.items.map((item) => item.id)).toEqual([literal]);
  for (const q of ["PendingTitle", "PendingBody", authorName, venue, "OnlyInUrl"]) {
    const { body } = await get({ q });
    expect(body.data?.items, q).toEqual([]);
    expect(body.meta.page?.totalCount, q).toBe(0);
  }
});

it("SQLの開催状態フィルター・件数とDTOがJST境界・マイクロ秒境界・中止優先で一致する", async () => {
  const referenceTime = new Date();
  const referenceIso = referenceTime.toISOString();
  const explicitEnd = (fraction: string) => referenceIso.replace("Z", `${fraction}Z`);
  const startsAt = new Date(referenceTime.getTime() - 86_400_000).toISOString();
  const exact = await addEvent({ startsAt, endsAt: referenceIso });
  const later = await addEvent({ startsAt, endsAt: explicitEnd("001") });
  const before = await addEvent({ startsAt, endsAt: new Date(referenceTime.getTime() - 1).toISOString() });
  const cancelled = await addEvent({ startsAt, endsAt: referenceIso, cancelled: true });
  await target.client.query('UPDATE "session" SET expires_at = expires_at + interval \'3 days\'');
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(referenceTime);
  for (const [state, expected] of [["scheduled", [later]], ["ended", [exact, before]], ["cancelled", [cancelled]]] as const) {
    const { status, body } = await get({ state });
    expect(status).toBe(200);
    expect(body.data?.items.map((item) => [item.id, item.holdingState]).sort())
      .toEqual(expected.map((id) => [id, state]).sort());
    expect(body.meta.page?.totalCount).toBe(expected.length);
  }
  expect((await get({ state: "all" })).body.meta.page?.totalCount).toBe(4);
  expect((await get({ state: "scheduled" })).body.data?.items[0]?.effectiveEndsAt).toBe(explicitEnd("001"));

  // 開始日が UTC と JST で異なるよう、JST 午前1時を開始にする。
  const day = 86_400_000;
  const jstOffset = 9 * 3_600_000;
  const midnight = (Math.floor((referenceTime.getTime() + jstOffset) / day) + 2) * day - jstOffset;
  const fallback = await addEvent({ title: "JstBoundary", startsAt: new Date(midnight - 23 * 3_600_000).toISOString() });
  for (const [offset, state] of [[-1, "scheduled"], [0, "ended"], [1, "ended"]] as const) {
    vi.setSystemTime(midnight + offset);
    const { status, body } = await get({ q: "JstBoundary", state });
    expect(status).toBe(200);
    expect(body.meta.page?.totalCount).toBe(1);
    expect(body.data?.items).toEqual([expect.objectContaining({
      id: fallback, holdingState: state, effectiveEndsAt: new Date(midnight).toISOString(),
    })]);
  }
});

it.each(["created_desc", "starts_asc"] as const)("%s は同値をID順に並べ、マイクロ秒精度でページングする", async (sort) => {
  const older = "2026-11-25T16:00:00.000100Z";
  const newer = "2026-11-25T16:00:00.000200Z";
  const olderFirst = await addEvent({ startsAt: older, createdAt: older });
  const olderSecond = await addEvent({ startsAt: older, createdAt: older });
  const latest = await addEvent({ startsAt: newer, createdAt: newer });
  await addEvent({ startsAt: "2026-11-25T16:00:00.000150Z", createdAt: newer, hidden: true });
  const tied = [olderFirst, olderSecond].sort();
  const expected = sort === "starts_asc" ? [...tied, latest] : [latest, ...tied.reverse()];
  let cursor: string | null = null;
  for (const [index, id] of expected.entries()) {
    const response = await get(new URLSearchParams({
      limit: "1", ...(sort === "starts_asc" ? { sort } : {}), ...(cursor ? { cursor } : {}),
    }).toString());
    expect(response.status).toBe(200);
    const { body } = response;
    expect(body.data?.items.map((item) => item.id)).toEqual([id]);
    expect(body.meta.page).toMatchObject({ totalCount: 3, hasMore: index < 2 });
    cursor = body.meta.page!.nextCursor;
    expect(cursor !== null).toBe(index < 2);
  }
});

it("カーソルを利用者・検索・開催状態・並び順にひも付け、続きでも現在の公開範囲を適用する", async () => {
  await addEvent({ createdAt: "2026-11-03T00:00:00Z" });
  const willHide = await addEvent({ createdAt: "2026-11-02T00:00:00Z" });
  const last = await addEvent({ createdAt: "2026-11-01T00:00:00Z" });
  const cursor = (await get({ limit: "1" })).body.meta.page!.nextCursor!;
  const invalidQueries: Record<string, string>[] = [
    { q: "公開", cursor }, { state: "ended", cursor }, { sort: "starts_asc", cursor }, { cursor: "invalid" },
  ];
  for (const query of invalidQueries) {
    const { status, body } = await get(query);
    expect({ status, code: body.error?.code }).toEqual({ status: 400, code: "INVALID_CURSOR" });
  }
  const other = await get({ cursor }, authorCookie);
  expect({ status: other.status, code: other.body.error?.code }).toEqual({ status: 400, code: "INVALID_CURSOR" });
  await target.client.query("UPDATE events SET forced_hidden_at = now() WHERE id = $1", [willHide]);
  const { body } = await get({ cursor });
  expect(body.data?.items.map((item) => item.id)).toEqual([last]);
  expect(body.meta.page).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null });
});

it.each(["state=unknown", "sort=updated_desc", "limit=0", "limit=51", "limit=1.5", "q=%20", "q=%00",
  `q=${"a".repeat(101)}`, "q=a&q=b", "authorId=x"])("不正なクエリー %s を共通エラーで拒否する", async (query) => {
  const { status, body } = await get(query);
  expect({ status, code: body.error?.code }).toEqual({ status: 400, code: "BAD_REQUEST" });
});

it("SEC-01 利用資格が未承認のセッションを拒否し、イベントや秘密情報を返さない", async () => {
  const id = await addEvent({ title: "SecretEventTitle", pendingEdit: true });
  await target.client.query("UPDATE community_users SET eligibility_status = 'pending' WHERE user_id = $1", [viewerId]);
  try {
    const { status, body, text } = await get();
    expect({ status, code: body.error?.code }).toEqual({ status: 403, code: "ACCOUNT_NOT_READY" });
    expect(Object.keys(body).sort()).toEqual(["error", "meta"]);
    expect(body.meta.page).toBeUndefined();
    const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
    for (const withheld of [id, viewerId, signingSecret, sessionToken, "SecretEventTitle", "PendingBody"]) {
      expect(text.includes(withheld)).toBe(false);
    }
  } finally {
    await target.client.query("UPDATE community_users SET eligibility_status = 'verified' WHERE user_id = $1", [viewerId]);
  }
  expect((await get()).status).toBe(200);
});
