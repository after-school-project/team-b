import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { defineAuthorizedApiRoute } from "../../src/api/authorized-route";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "../../src/api/pagination";
import { parsePathParams, userId as userIdSchema, uuid } from "../../src/api/request";
import { ApiError } from "../../src/api/response";
import { POST as authPost } from "../../src/app/api/auth/[...auth]/route";
import { isOwner, ownedBy, requireOwned } from "../../src/auth/ownership";
import {
  projectOptionalProfileFields, publicProfileState, publishedEvent, publishedNotice, retainedDeletedNotice,
  visibleQuestion,
} from "../../src/auth/visibility";
import {
  eventRevisions, events, noticeRequests, noticeRevisions, notices, qaQuestions,
} from "../../src/db/content-schema";
import { notifications } from "../../src/db/moderation-schema";
import { communityUsers, profileRevisions, profiles } from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 所有者・公開範囲・対象状態による取得制御（#7 ④）。共通処理を使う検証用の経路で、
 * AC-06（他人の本人用データは404）、AC-07（非公開項目・未承認版・削除済みを一覧・件数・カーソルに含めない）、
 * SEC-01 の共通部分（未承認の利用者は一覧APIを利用できない）を確認する。
 * 各機能の一覧・検索APIでの確認は、担当の機能Issue（#9・#11・#13 など）で機能と同じPRに追加する。
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

const database = () => drizzle(pool);

// 一般の閲覧者に返してはならない本文。どの応答にも含まれないことを確認する。
const hidden = {
  question: "強制非表示の質問（検証用）",
  deletedQuestion: "削除済みの質問（検証用）",
  pendingNotice: "卒業生とのキャリア相談（詳細追記）",
  draftNotice: "未公開のお知らせ（検証用）",
  hiddenNotice: "強制非表示のお知らせ（検証用）",
  deletedNotice: "削除済みのお知らせ（検証用）",
  pendingEvent: "在校生の制作もくもく会",
  hiddenEvent: "強制非表示のイベント（検証用）",
  selfOnlyField: "本人だけに見せる興味（検証用）",
} as const;
const forbiddenTexts = Object.values(hidden);

let deletedNoticeId: string;
let expiredNoticeId: string;
let pendingRequestId: string;

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-data-access-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user"');
  for (const { id, username } of rows) ids.set(username, id);
  await addContent();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

function userId(username: string): string {
  const id = ids.get(username);
  if (!id) throw new Error(`${username} がありません`);
  return id;
}

/** seed に、一般の閲覧者へ返してはならない状態の投稿を追加する。 */
async function addContent() {
  const query = (text: string, values: unknown[] = []) => target.client.query(text, values);
  const student = userId("poc_s001");
  const alumni = userId("poc_a001");
  const staff = userId("poc_staff");

  // DBの日時はマイクロ秒まで保持する。同じミリ秒内の投稿でも、カーソルでページをたどったときに抜けないことを確認する。
  const { rows: [{ id: categoryId }] } = await query("SELECT id FROM qa_categories WHERE code = 'learning'");
  const question = (title: string, createdAt: string, state = "") => query(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, created_at${state ? ", " + state : ""})
    VALUES ($1, $2, $3, '本文', 'はる', $4${state ? ", now()" : ""})
  `, [student, categoryId, title, createdAt]);
  await question("公開中の質問（検証用）", "2026-11-02T00:00:00.000200Z");
  await question(hidden.question, "2026-11-02T00:00:00.000150Z", "forced_hidden_at");
  await question("同じミリ秒内の公開中の質問（検証用）", "2026-11-02T00:00:00.000100Z");
  await question(hidden.deletedQuestion, "2026-11-04T00:00:00.000Z", "deleted_at");

  async function notice(title: string, author: string, publish: boolean, state = "") {
    const { rows: [{ id }] } = await query(
      "INSERT INTO notices (author_id, origin_kind) VALUES ($1, $2) RETURNING id",
      [author, author === staff ? "school" : "alumni"],
    );
    const { rows: [revision] } = await query(`
      INSERT INTO notice_revisions (notice_id, revision_no, title, body, category_code)
      VALUES ($1, 1, $2, '本文', 'general') RETURNING id
    `, [id, title]);
    if (publish) {
      await query(`UPDATE notices SET public_revision_id = $2, first_published_at = now()${state ? ", " + state : ""}
        WHERE id = $1`, [id, revision.id]);
    }
    return id as string;
  }
  await notice(hidden.draftNotice, alumni, false);
  await notice(hidden.hiddenNotice, alumni, true, "forced_hidden_at = now()");
  deletedNoticeId = await notice(hidden.deletedNotice, alumni, true, "deleted_at = now() - interval '10 days'");
  expiredNoticeId = await notice("期限切れの削除済みお知らせ", alumni, true, "deleted_at = now() - interval '181 days'");

  async function event(title: string, state: string) {
    const { rows: [{ id }] } = await query(
      "INSERT INTO events (author_id, origin_kind) VALUES ($1, 'staff') RETURNING id", [staff],
    );
    const { rows: [revision] } = await query(`
      INSERT INTO event_revisions (event_id, revision_no, title, description, starts_at, format)
      VALUES ($1, 1, $2, '説明', now() + interval '3 days', 'online') RETURNING id
    `, [id, title]);
    await query(`UPDATE events SET public_revision_id = $2, first_published_at = now(), ${state} WHERE id = $1`,
      [id, revision.id]);
  }
  await event(hidden.hiddenEvent, "forced_hidden_at = now()");
  await event("中止したイベント（検証用）", "cancelled_at = now()");

  ({ rows: [{ id: pendingRequestId }] } = await query("SELECT id FROM notice_requests WHERE status = 'pending'"));
  await query(`
    UPDATE profile_revisions SET optional_values = optional_values || jsonb_build_object('interests', $2::text)
    WHERE id = (SELECT current_revision_id FROM profiles WHERE user_id = $1)
  `, [alumni, hidden.selfOnlyField]);
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

type Route = { GET: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> };
type Body = {
  data?: { items?: Record<string, unknown>[] } & Record<string, unknown>;
  error?: { code: string; message: string; fields: unknown[] };
  meta: { page?: { totalCount: number; hasMore: boolean; nextCursor: string | null } };
};

async function get(route: Route, cookie: string, path: string, params: Record<string, string> = {}) {
  const response = await route.GET(new Request(origin + path, { headers: { Cookie: cookie } }), {
    params: Promise.resolve(params),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

function expectNoForbiddenText(text: string) {
  for (const forbidden of forbiddenTexts) expect(text).not.toContain(forbidden);
}

const position = z.tuple([z.string(), z.string()]);

/** 一般のQ&A一覧（作成日時の降順）。公開条件を件数・各ページ・カーソルに適用する。 */
const questionsRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(request, _context, viewer) {
    const { limit, cursor } = parseListQuery(new URL(request.url), {});
    const codec = createCursorCodec(
      { actorId: viewer.userId, list: "questions", filters: {}, sort: "createdAt:desc,id:desc" }, position,
    );
    const last = codec.decode(cursor);
    return queryListPage({
      authorized: visibleQuestion(),
      after: last ? sql`(${qaQuestions.createdAt}, ${qaQuestions.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
      limit,
      rows: (where, take) => database().select({ id: qaQuestions.id, title: qaQuestions.title, cursorAt: cursorTimestamp(qaQuestions.createdAt) })
        .from(qaQuestions).where(where).orderBy(desc(qaQuestions.createdAt), desc(qaQuestions.id)).limit(take),
      count: async (where) => (await database().select({ n: count() }).from(qaQuestions).where(where))[0].n,
      cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    });
  },
});

/** 公開版の本文だけを返す一覧（お知らせ・イベント）。 */
function publishedListRoute(kind: "notices" | "events") {
  return defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
    async GET(request) {
      const { limit } = parseListQuery(new URL(request.url), {});
      const select = (where: SQL, take: number) => kind === "notices"
        ? database().select({ id: notices.id, title: noticeRevisions.title }).from(notices)
          .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
          .where(where).orderBy(notices.id).limit(take)
        : database().select({ id: events.id, title: eventRevisions.title }).from(events)
          .innerJoin(eventRevisions, eq(eventRevisions.id, events.publicRevisionId))
          .where(where).orderBy(events.id).limit(take);
      const table = kind === "notices" ? notices : events;
      return queryListPage({
        authorized: kind === "notices" ? publishedNotice() : publishedEvent(),
        limit,
        rows: select,
        count: async (where) => (await database().select({ n: count() }).from(table).where(where))[0].n,
        cursorFor: () => { throw new Error("検証では全件を1ページで取得する"); },
      });
    },
  });
}
const noticesRoute = publishedListRoute("notices");
const eventsRoute = publishedListRoute("events");

/** 本人の通知一覧。所有者の条件で絞る。 */
const myNotificationsRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(request, _context, viewer) {
    const { limit } = parseListQuery(new URL(request.url), {});
    return queryListPage({
      authorized: ownedBy(notifications.recipientId, viewer),
      limit,
      rows: (where, take) => database().select({ id: notifications.id, recipientId: notifications.recipientId })
        .from(notifications).where(where).orderBy(notifications.id).limit(take),
      count: async (where) => (await database().select({ n: count() }).from(notifications).where(where))[0].n,
      cursorFor: () => { throw new Error("検証では全件を1ページで取得する"); },
    });
  },
});

/** 本人の申請詳細。申請の所有者は親のお知らせの投稿者で判定する。 */
const myNoticeRequestRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(_request, context, viewer) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    const [row] = await database().select({ id: noticeRequests.id, status: noticeRequests.status, authorId: notices.authorId })
      .from(noticeRequests).innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
      .where(eq(noticeRequests.id, requestId));
    const { id, status } = requireOwned(row, (owned) => owned.authorId, viewer);
    return { data: { id, status } };
  },
});

/** 本人の削除済みお知らせの本文。削除から180日を過ぎたら返さない。 */
const myDeletedNoticeRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(_request, context, viewer) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    const [row] = await database().select({ id: notices.id, title: noticeRevisions.title }).from(notices)
      .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
      .where(and(eq(notices.id, noticeId), ownedBy(notices.authorId, viewer), retainedDeletedNotice()));
    if (!row) throw new ApiError("NOT_FOUND");
    return { data: row };
  },
});

/** 他人・本人のプロフィール。非表示中は状態案内だけ、任意項目は見る相手に応じて絞る。 */
const profileRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(_request, context, viewer) {
    const { userId: subject } = parsePathParams(await context.params, { userId: userIdSchema });
    const [row] = await database().select({
      profileState: communityUsers.profileState,
      displayName: profileRevisions.displayName,
      optionalValues: profileRevisions.optionalValues,
      fieldVisibility: profileRevisions.fieldVisibility,
    }).from(communityUsers)
      .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
      .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
      .where(eq(communityUsers.userId, subject));
    if (!row) throw new ApiError("NOT_FOUND");
    const owner = isOwner(viewer, subject);
    if (!owner && row.profileState !== "public") return { data: { userId: subject, state: "hidden" } };
    return {
      data: {
        userId: subject,
        state: row.profileState,
        displayName: row.displayName,
        optionalFields: projectOptionalProfileFields(row, owner ? "owner" : "member"),
      },
    };
  },
});

/** プロフィール公開中の利用者だけを数える一覧。 */
const publicProfilesRoute = defineAuthorizedApiRoute<{ params: Promise<Record<string, string>> }>({
  async GET(request) {
    const { limit } = parseListQuery(new URL(request.url), {});
    return queryListPage({
      authorized: publicProfileState(),
      limit,
      rows: (where, take) => database().select({ userId: communityUsers.userId }).from(communityUsers)
        .where(where).orderBy(communityUsers.userId).limit(take),
      count: async (where) => (await database().select({ n: count() }).from(communityUsers).where(where))[0].n,
      cursorFor: () => { throw new Error("検証では全件を1ページで取得する"); },
    });
  },
});

describe("AC-07：未承認版・強制非表示・削除済みを一覧・件数・カーソルに含めない", () => {
  it("Q&Aの一覧は、ページをたどっても強制非表示・削除済みの質問を返さず、件数にも含めない", async () => {
    const cookie = await logIn("poc_s001");
    const titles: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = "/api/v1/questions?limit=1" + (cursor ? "&cursor=" + cursor : "");
      const { status, body, text } = await get(questionsRoute, cookie, path);
      expect(status).toBe(200);
      expectNoForbiddenText(text);
      expect(body.meta.page!.totalCount).toBe(3);
      titles.push(...body.data!.items!.map((item) => item.title as string));
      cursor = body.meta.page!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(titles).toEqual([
      "チーム開発で最初に揃えておくとよいことは？", "公開中の質問（検証用）", "同じミリ秒内の公開中の質問（検証用）",
    ]);
    expect(pages).toBe(3);
  });

  it("お知らせの一覧は公開版の本文だけを返し、審査中の版・未公開・強制非表示・削除済みを含めない", async () => {
    const { status, body, text } = await get(noticesRoute, await logIn("poc_s001"), "/api/v1/notices?limit=50");
    expect(status).toBe(200);
    expectNoForbiddenText(text);
    expect(text).not.toContain("期限切れの削除済みお知らせ");
    expect(body.data!.items!.map((item) => item.title).sort())
      .toEqual(["卒業生とのキャリア相談", "開発環境オリエンテーション"].sort());
    expect(body.meta.page!.totalCount).toBe(2);
  });

  it("イベントの一覧は、中止したイベントを含め、未公開・強制非表示を含めない", async () => {
    const { status, body, text } = await get(eventsRoute, await logIn("poc_s001"), "/api/v1/events?limit=50");
    expect(status).toBe(200);
    expectNoForbiddenText(text);
    expect(body.data!.items!.map((item) => item.title).sort())
      .toEqual(["中止したイベント（検証用）", "学校と卒業生の交流会"].sort());
    expect(body.meta.page!.totalCount).toBe(2);
  });

  it("他人のプロフィールでは本人のみの任意項目を返さず、非表示中はプロフィール情報を返さない", async () => {
    const alumni = userId("poc_a001");
    const other = await get(profileRoute, await logIn("poc_s001"), "/api/v1/users/x/profile", { userId: alumni });
    expect(other.status).toBe(200);
    expect(other.text).not.toContain(hidden.selfOnlyField);
    expect(other.body.data!.optionalFields).toEqual({ bio: { value: "開発用のサンプルプロフィールです。", visibility: "members" } });

    const self = await get(profileRoute, await logIn("poc_a001"), "/api/v1/users/x/profile", { userId: alumni });
    expect(self.body.data!.optionalFields).toMatchObject({ interests: { value: hidden.selfOnlyField, visibility: "self" } });

    const hiddenProfile = await get(profileRoute, await logIn("poc_s001"), "/api/v1/users/x/profile",
      { userId: userId("poc_hidden") });
    expect(hiddenProfile.body.data).toEqual({ userId: userId("poc_hidden"), state: "hidden" });
    expect(hiddenProfile.text).not.toContain("ゆう");
  });

  it("プロフィール公開中の利用者だけを一覧・件数に含める", async () => {
    const { body } = await get(publicProfilesRoute, await logIn("poc_s001"), "/api/v1/profiles?limit=50");
    const userIds = body.data!.items!.map((item) => item.userId);
    expect(userIds).not.toContain(userId("poc_hidden"));
    const { rows: [{ n }] } = await target.client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM community_users WHERE profile_state = 'public'",
    );
    expect(body.meta.page!.totalCount).toBe(n);
    expect(userIds).toHaveLength(n);
  });
});

describe("AC-06：他人の本人用データを取得できず、存在の有無を明かさない", () => {
  it("本人の通知一覧には自分宛ての通知だけを返し、件数にも他人宛てを含めない", async () => {
    for (const username of ["poc_s001", "poc_school"]) {
      const { status, body } = await get(myNotificationsRoute, await logIn(username), "/api/v1/me/notifications?limit=50");
      expect(status).toBe(200);
      const { rows: [{ n }] } = await target.client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1", [userId(username)],
      );
      expect(n).toBeGreaterThan(0);
      expect(body.meta.page!.totalCount).toBe(n);
      expect(body.data!.items!.map((item) => item.recipientId)).toEqual(Array(n).fill(userId(username)));
    }
  });

  it("受信者IDを送っても判定に使わず、他人の通知を取得できない", async () => {
    const cookie = await logIn("poc_s001");
    const { status, body } = await get(myNotificationsRoute, cookie,
      `/api/v1/me/notifications?recipientId=${userId("poc_school")}`);
    expect({ status, code: body.error?.code }).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(body.data).toBeUndefined();
  });

  it("他人の申請は、存在しない申請と同じ404で拒否する", async () => {
    const path = "/api/v1/me/notice-requests/x";
    const owner = await get(myNoticeRequestRoute, await logIn("poc_a001"), path, { requestId: pendingRequestId });
    expect(owner).toMatchObject({ status: 200, body: { data: { id: pendingRequestId, status: "pending" } } });

    const cookie = await logIn("poc_s001");
    const other = await get(myNoticeRequestRoute, cookie, path, { requestId: pendingRequestId });
    const missing = await get(myNoticeRequestRoute, cookie, path, { requestId: randomUUID() });
    expect(other.status).toBe(404);
    expect(other.body.error).toEqual(missing.body.error);
    expect(Object.keys(other.body).sort()).toEqual(["error", "meta"]);
    expect(other.text).not.toContain("pending");
  });

  it("削除済みお知らせの本文は、本人でも削除から180日を過ぎたら返さず、他人には期間内でも返さない", async () => {
    const path = "/api/v1/me/notices/x/deleted-content";
    const ownerCookie = await logIn("poc_a001");
    expect(await get(myDeletedNoticeRoute, ownerCookie, path, { noticeId: deletedNoticeId }))
      .toMatchObject({ status: 200, body: { data: { title: hidden.deletedNotice } } });
    const expired = await get(myDeletedNoticeRoute, ownerCookie, path, { noticeId: expiredNoticeId });
    expect({ status: expired.status, code: expired.body.error?.code }).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(expired.text).not.toContain("期限切れの削除済みお知らせ");

    const other = await get(myDeletedNoticeRoute, await logIn("poc_a_mgr"), path, { noticeId: deletedNoticeId });
    expect({ status: other.status, code: other.body.error?.code }).toEqual({ status: 404, code: "NOT_FOUND" });
    expectNoForbiddenText(other.text);
  });
});

describe("SEC-01（共通部分）：未承認の利用者はQ&A・お知らせ・イベントの一覧APIを利用できない", () => {
  it.each([
    ["学校による利用資格確認が未完了", "eligibility_status = 'pending'", "eligibility_status = 'verified'"],
    ["アカウント発行が未完了", "provisioning_status = 'pending'", "provisioning_status = 'ready'"],
  ])("%sの利用者は403 ACCOUNT_NOT_READY とし、一覧の本文・件数を返さない", async (_label, change, restore) => {
    const cookie = await logIn("poc_s002");
    await target.client.query(`UPDATE community_users SET ${change} WHERE user_id = $1`, [userId("poc_s002")]);
    try {
      for (const [route, path] of [
        [questionsRoute, "/api/v1/questions"], [noticesRoute, "/api/v1/notices"], [eventsRoute, "/api/v1/events"],
      ] as const) {
        const { status, body, text } = await get(route, cookie, path);
        expect({ status, code: body.error?.code }).toEqual({ status: 403, code: "ACCOUNT_NOT_READY" });
        expect(Object.keys(body).sort()).toEqual(["error", "meta"]);
        expect(body.meta.page).toBeUndefined();
        expect(text).not.toContain("チーム開発で最初に揃えておくとよいことは？");
        expect(text).not.toContain("開発環境オリエンテーション");
        expect(text).not.toContain("学校と卒業生の交流会");
      }
    } finally {
      await target.client.query(`UPDATE community_users SET ${restore} WHERE user_id = $1`, [userId("poc_s002")]);
    }
    // 承認済みに戻れば、同じセッションで一覧を利用できる。
    expect((await get(questionsRoute, cookie, "/api/v1/questions")).status).toBe(200);
  });
});
