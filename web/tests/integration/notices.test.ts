import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const marker = `notice-test-${randomUUID()}`;
const day = 24 * 60 * 60 * 1_000;

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let ids: Map<string, string>;
let categoriesRoute: typeof import("../../src/app/api/v1/notice-categories/route");
let noticesRoute: typeof import("../../src/app/api/v1/notices/route");
let noticeRoute: typeof import("../../src/app/api/v1/notices/[noticeId]/route");
let deletionRoute: typeof import("../../src/app/api/v1/notices/[noticeId]/deletion/route");
let revisionsRoute: typeof import("../../src/app/api/v1/notices/[noticeId]/revisions/route");
let myNoticesRoute: typeof import("../../src/app/api/v1/me/notices/route");
let myNoticeRoute: typeof import("../../src/app/api/v1/me/notices/[noticeId]/route");
let requestListRoute: typeof import("../../src/app/api/v1/me/notices/[noticeId]/requests/route");
let requestRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/route");
let withdrawalRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/withdrawal/route");
let resubmissionRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/resubmission/route");
let adminRequestsRoute: typeof import("../../src/app/api/v1/admin/notice-requests/route");
let adminRequestRoute: typeof import("../../src/app/api/v1/admin/notice-requests/[requestId]/route");
let decisionRoute: typeof import("../../src/app/api/v1/admin/notice-requests/[requestId]/decision/route");
let managedNoticesRoute: typeof import("../../src/app/api/v1/admin/notices/route");
let managedNoticeRoute: typeof import("../../src/app/api/v1/admin/notices/[noticeId]/route");
let visibilityRoute: typeof import("../../src/app/api/v1/admin/notices/[noticeId]/visibility/route");
let ipCounter = 0;
const cookies = new Map<string, string>();
const createdNoticeIds = new Set<string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-notices-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8")) as Record<string, string>;
  const { rows } = await target.client.query<{ id: string; username: string }>(
    'SELECT id, username FROM "user" WHERE username IS NOT NULL',
  );
  ids = new Map(rows.map(({ id, username }) => [username, id]));
  categoriesRoute = await import("../../src/app/api/v1/notice-categories/route");
  noticesRoute = await import("../../src/app/api/v1/notices/route");
  noticeRoute = await import("../../src/app/api/v1/notices/[noticeId]/route");
  deletionRoute = await import("../../src/app/api/v1/notices/[noticeId]/deletion/route");
  revisionsRoute = await import("../../src/app/api/v1/notices/[noticeId]/revisions/route");
  myNoticesRoute = await import("../../src/app/api/v1/me/notices/route");
  myNoticeRoute = await import("../../src/app/api/v1/me/notices/[noticeId]/route");
  requestListRoute = await import("../../src/app/api/v1/me/notices/[noticeId]/requests/route");
  requestRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/route");
  withdrawalRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/withdrawal/route");
  resubmissionRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/resubmission/route");
  adminRequestsRoute = await import("../../src/app/api/v1/admin/notice-requests/route");
  adminRequestRoute = await import("../../src/app/api/v1/admin/notice-requests/[requestId]/route");
  decisionRoute = await import("../../src/app/api/v1/admin/notice-requests/[requestId]/decision/route");
  managedNoticesRoute = await import("../../src/app/api/v1/admin/notices/route");
  managedNoticeRoute = await import("../../src/app/api/v1/admin/notices/[noticeId]/route");
  visibilityRoute = await import("../../src/app/api/v1/admin/notices/[noticeId]/visibility/route");
});

afterEach(async () => {
  if (!createdNoticeIds.size) return;
  const noticeIds = [...createdNoticeIds];
  await target.client.query(`
    DELETE FROM notifications WHERE notice_request_id IN (
      SELECT id FROM notice_requests WHERE notice_id = ANY($1::uuid[])
    )
  `, [noticeIds]);
  await target.client.query("DELETE FROM notice_requests WHERE notice_id = ANY($1::uuid[])", [noticeIds]);
  await target.client.query("UPDATE notices SET public_revision_id = NULL WHERE id = ANY($1::uuid[])", [noticeIds]);
  await target.client.query("DELETE FROM notice_revisions WHERE notice_id = ANY($1::uuid[])", [noticeIds]);
  await target.client.query("DELETE FROM notices WHERE id = ANY($1::uuid[])", [noticeIds]);
  createdNoticeIds.clear();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

function id(username: string) {
  const value = ids.get(username);
  if (!value) throw new Error(`Missing test account: ${username}`);
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

async function headersFor(viewer: string | null, mutation = false, key: string = randomUUID()): Promise<HeadersInit> {
  return {
    ...(viewer ? { Cookie: await cookieFor(viewer) } : {}),
    ...(mutation ? {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    } : {}),
  };
}

type Body = {
  data?: { items?: Record<string, unknown>[]; [key: string]: unknown };
  error?: { code: string; message: string };
  meta: { page?: { totalCount: number; hasMore: boolean; nextCursor: string | null } };
};

async function parse(response: Response) {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Body };
}

async function get<Context>(
  route: { GET: (request: Request, context: Context) => Promise<Response> },
  path: string,
  viewer: string | null,
  context: Context,
) {
  return parse(await route.GET(new Request(origin + path, { headers: await headersFor(viewer) }), context));
}

async function post<Context>(
  route: { POST: (request: Request, context: Context) => Promise<Response> },
  path: string,
  viewer: string,
  body: unknown,
  context: Context,
  key?: string,
) {
  return parse(await route.POST(new Request(origin + path, {
    method: "POST",
    headers: await headersFor(viewer, true, key),
    body: JSON.stringify(body),
  }), context));
}

async function addNotice({
  author = "poc_a001",
  title = `${marker} 公開題名`,
  body = `${marker} 公開本文`,
  published = true,
  hidden = false,
  deletedAt = null,
  pendingStatus,
  requestKind = "edit",
  version = 1,
}: {
  author?: string;
  title?: string;
  body?: string;
  published?: boolean;
  hidden?: boolean;
  deletedAt?: Date | null;
  pendingStatus?: "pending" | "rejected" | "withdrawn";
  requestKind?: "new" | "edit";
  version?: number;
} = {}) {
  const originKind = author.startsWith("poc_staff") || author === "poc_school" ? "school" : "alumni";
  const { rows: [{ id: noticeId }] } = await target.client.query<{ id: string }>(`
    INSERT INTO notices (author_id, origin_kind, version, first_published_at, forced_hidden_at, deleted_at)
    VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, $6)
    RETURNING id
  `, [id(author), originKind, version, published, hidden, deletedAt]);
  createdNoticeIds.add(noticeId);
  const { rows: [{ id: revisionId }] } = await target.client.query<{ id: string }>(`
    INSERT INTO notice_revisions (notice_id, revision_no, title, body, category_code)
    VALUES ($1, 1, $2, $3, 'general') RETURNING id
  `, [noticeId, title, body]);
  if (published) {
    await target.client.query("UPDATE notices SET public_revision_id = $1 WHERE id = $2", [revisionId, noticeId]);
  }
  let requestId: string | null = null;
  if (pendingStatus) {
    const requestBody = pendingStatus === "pending" ? `${marker} 申請本文` : `${marker} 却下後本文`;
    const { rows: [{ id: requestRevisionId }] } = await target.client.query<{ id: string }>(`
      INSERT INTO notice_revisions (notice_id, revision_no, title, body, category_code)
      VALUES ($1, 2, $2, $3, 'general') RETURNING id
    `, [noticeId, `${marker} 申請題名`, requestBody]);
    const { rows: [request] } = await target.client.query<{ id: string }>(`
      INSERT INTO notice_requests
        (notice_id, revision_id, request_kind, status, submitted_at, reviewer_id, decided_at, version)
      VALUES ($1, $2, $3, $4, now(), $5, CASE WHEN $4 = 'pending' THEN NULL ELSE now() END, 1)
      RETURNING id
    `, [noticeId, requestRevisionId, requestKind, pendingStatus, pendingStatus === "pending" ? null : id("poc_school")]);
    requestId = request.id;
  }
  return { id: noticeId, requestId };
}

const noticeContext = (noticeId: string) => ({ params: Promise.resolve({ noticeId }) });
const requestContext = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
const titles = (body: Body) => (body.data?.items ?? []).map((item) => item.title);

const adminRequestsPath = "/api/v1/admin/notice-requests";
const managedNoticesPath = "/api/v1/admin/notices";

function expectNoticeDenied(result: Awaited<ReturnType<typeof parse>>, status: number, code: string) {
  expect(result.status).toBe(status);
  expect(result.body.error?.code).toBe(code);
  expect(result.body.data).toBeUndefined();
  expect(result.text).not.toContain(marker);
}

it("Issue #14 AC-01・AC-02 審査一覧を受付順・種別で絞り、取り下げ済みを一覧と詳細から除外する", async () => {
  const first = await addNotice({ pendingStatus: "pending", requestKind: "new", published: false });
  const second = await addNotice({ pendingStatus: "pending", requestKind: "new", published: false });
  const withdrawn = await addNotice({ pendingStatus: "withdrawn", requestKind: "new", published: false });
  await target.client.query("UPDATE notice_requests SET submitted_at = '2000-01-01' WHERE id = $1", [first.requestId]);
  await target.client.query("UPDATE notice_requests SET submitted_at = '2000-01-02' WHERE id = $1", [second.requestId]);
  await target.client.query("UPDATE notice_requests SET submitted_at = '1999-12-31' WHERE id = $1", [withdrawn.requestId]);
  const url = adminRequestsPath + "?status=pending&kind=new&limit=1";
  const firstPage = await get(adminRequestsRoute, url, "poc_school", {});
  expect(firstPage.body.data?.items).toEqual([expect.objectContaining({ id: first.requestId, canReview: true })]);
  expect(firstPage.body.meta.page?.hasMore).toBe(true);
  expect(firstPage.text).not.toContain(marker);
  const secondPage = await get(adminRequestsRoute,
    url + "&cursor=" + encodeURIComponent(firstPage.body.meta.page!.nextCursor!), "poc_school", {});
  expect(secondPage.body.data?.items).toEqual([expect.objectContaining({ id: second.requestId })]);
  for (const manager of ["poc_school", "poc_s_mgr"]) {
    const path = `${adminRequestsPath}/${withdrawn.requestId}`;
    expectNoticeDenied(await get(adminRequestRoute, path, manager, requestContext(withdrawn.requestId!)), 404, "NOT_FOUND");
    expectNoticeDenied(await post(decisionRoute, path + "/decision", manager,
      { expectedVersion: 1, decision: "approve" }, requestContext(withdrawn.requestId!)), 404, "NOT_FOUND");
  }
  expectNoticeDenied(await get(adminRequestsRoute, url, "poc_s001", {}), 403, "FORBIDDEN");
});

it("Issue #14 SEC-25 同時承認は一方のみ確定し、旧版拒否・再送と通知の一意性を保つ", async () => {
  const { id: noticeId, requestId } = await addNotice({ pendingStatus: "pending", requestKind: "new", published: false });
  const path = `${adminRequestsPath}/${requestId}/decision`;
  const ctx = requestContext(requestId!);
  const input = { expectedVersion: 1, decision: "approve" };
  expectNoticeDenied(await post(decisionRoute, path, "poc_school", { ...input, expectedVersion: 2 }, ctx), 409, "VERSION_CONFLICT");
  const managers = ["poc_school", "poc_s_mgr"];
  const keys = managers.map(() => randomUUID());
  const decisions = await Promise.all(managers.map((manager, index) => post(decisionRoute, path, manager, input, ctx, keys[index])));
  const winner = decisions.findIndex((response) => response.status === 200);
  expect(winner).toBeGreaterThanOrEqual(0);
  expectNoticeDenied(decisions[1 - winner], 409, "VERSION_CONFLICT");
  const receipt = decisions[winner].body.data;
  expect(receipt).toMatchObject({ state: "approved", version: 2 });
  const replay = await post(decisionRoute, path, managers[winner], input, ctx, keys[winner]);
  expect(replay.body.data).toEqual(receipt);
  expectNoticeDenied(await post(decisionRoute, path, managers[winner], { ...input, expectedVersion: 2 }, ctx), 409, "STATE_CONFLICT");

  const { rows } = await target.client.query(`
    SELECT n.public_revision_id = nr.revision_id AS revision_published, nr.status, nr.version, nr.reviewer_id,
      n.first_published_at = nr.decided_at AS initially_published
    FROM notices n JOIN notice_requests nr ON n.id = nr.notice_id WHERE n.id = $1
  `, [noticeId]);
  expect(rows).toEqual([{ revision_published: true, status: "approved", version: 2,
    reviewer_id: id(managers[winner]), initially_published: true }]);
  const notifications = await target.client.query(
    "SELECT recipient_id, public_message FROM notifications WHERE notice_request_id = $1 AND kind = 'notice_review_decided'", [requestId]);
  expect(notifications.rows).toEqual([{ recipient_id: id("poc_a001"), public_message: "お知らせの申請が承認されました。" }]);
});

it("Issue #14 SEC-08 卒業生兼アプリ管理者は自己審査を拒否され、自分の公開投稿を非表示・復元できる", async () => {
  const { id: noticeId, requestId } = await addNotice({ author: "poc_a_mgr", pendingStatus: "pending" });
  const manager = "poc_a_mgr";
  const path = `${adminRequestsPath}/${requestId}`;
  const ctx = requestContext(requestId!);
  const listing = await get(adminRequestsRoute, adminRequestsPath + "?kind=edit&limit=50", manager, {});
  expect(listing.body.data?.items).toContainEqual(expect.objectContaining({ id: requestId, canReview: false }));
  const detail = await get(adminRequestRoute, path, manager, ctx);
  expect(detail.body.data?.capabilities).toMatchObject({ canReview: false });
  for (const decision of ["approve", "reject"]) {
    expectNoticeDenied(await post(decisionRoute, path + "/decision", manager, { decision, expectedVersion: 1 }, ctx), 403, "FORBIDDEN");
  }
  await target.client.query("UPDATE notices SET updated_at = '2025-01-01' WHERE id = $1", [noticeId]);
  const noticeState = () => target.client.query("SELECT version, updated_at, public_revision_id FROM notices WHERE id = $1", [noticeId]);
  const before = await noticeState();
  const rejected = await post(decisionRoute, path + "/decision", "poc_s_mgr", { decision: "reject", expectedVersion: 1 }, ctx);
  expect(rejected.body.data).toMatchObject({ state: "rejected", version: 2 });
  expect((await noticeState()).rows).toEqual(before.rows);
  const ownerResult = await get(requestRoute, `/api/v1/me/notice-requests/${requestId}`, manager, ctx);
  expect(ownerResult.body.data).toMatchObject({ status: "rejected", decisionReason: null });
  const notices = await target.client.query("SELECT public_message FROM notifications WHERE notice_request_id = $1 AND kind = 'notice_review_decided'", [requestId]);
  expect(notices.rows).toEqual([{ public_message: "お知らせの申請が却下されました。" }]);

  const visibilityPath = `${managedNoticesPath}/${noticeId}/visibility`;
  expect((await post(visibilityRoute, visibilityPath, manager,
    { visibility: "hidden", expectedVersion: 1 }, noticeContext(noticeId))).body.data?.state).toBe("hidden");
  expect((await post(visibilityRoute, visibilityPath, manager,
    { visibility: "public", expectedVersion: 2 }, noticeContext(noticeId))).body.data?.state).toBe("public");
});

it("Issue #14 SEC-07 アプリ管理者は学校公式を非表示・復元できず、強制非表示の本体と件数を取得できない", async () => {
  const { id: noticeId } = await addNotice({ author: "poc_staff" });
  const path = `${managedNoticesPath}/${noticeId}`;
  const ctx = noticeContext(noticeId);
  const manager = "poc_s_mgr";
  const publicDetail = await get(managedNoticeRoute, path, manager, ctx);
  expect(publicDetail.body.data?.capabilities).toMatchObject({ canHide: false, canRestore: false });
  const before = await get(managedNoticesRoute, managedNoticesPath + "?state=hidden", manager, {});
  expectNoticeDenied(await post(visibilityRoute, path + "/visibility", manager,
    { visibility: "hidden", expectedVersion: 1 }, ctx), 403, "FORBIDDEN");
  expect((await post(visibilityRoute, path + "/visibility", "poc_school",
    { visibility: "hidden", expectedVersion: 1 }, ctx)).body.data?.state).toBe("hidden");
  for (const visibility of ["hidden", "public"]) {
    expectNoticeDenied(await post(visibilityRoute, path + "/visibility", manager,
      { visibility, expectedVersion: 2 }, ctx), 404, "NOT_FOUND");
  }
  expectNoticeDenied(await get(managedNoticeRoute, path, manager, ctx), 404, "NOT_FOUND");
  const after = await get(managedNoticesRoute, managedNoticesPath + "?state=hidden", manager, {});
  expect(after.body.meta.page?.totalCount).toBe(before.body.meta.page?.totalCount);
  expect(after.text).not.toContain(noticeId);
  expect((await get(managedNoticeRoute, path, "poc_school", ctx)).body.data).toMatchObject({
    publicationState: "hidden", capabilities: { canRestore: true },
  });
  expect((await post(visibilityRoute, path + "/visibility", "poc_school",
    { visibility: "public", expectedVersion: 2 }, ctx)).body.data?.state).toBe("public");
  expect((await post(deletionRoute, `/api/v1/notices/${noticeId}/deletion`, "poc_staff",
    { expectedVersion: 3, confirmed: true }, ctx)).status).toBe(200);
  for (const visibility of ["hidden", "public"]) {
    expectNoticeDenied(await post(visibilityRoute, path + "/visibility", manager,
      { visibility, expectedVersion: 4 }, ctx), 404, "NOT_FOUND");
  }
});

it("Issue #14 SEC-23 空欄の非表示・復元を監査し、再送で重複記録や個別通知を作らない", async () => {
  const { id: noticeId } = await addNotice();
  const path = `${managedNoticesPath}/${noticeId}/visibility`;
  const ctx = noticeContext(noticeId);
  const manager = "poc_s_mgr";
  const ownerNotifications = () => target.client.query("SELECT count(*) FROM notifications WHERE recipient_id = $1", [id("poc_a001")]);
  const before = await ownerNotifications();
  for (const [visibility, version] of [["hidden", 1], ["public", 2]] as const) {
    const input = { visibility, expectedVersion: version, reason: "  " };
    const key = randomUUID();
    const first = await post(visibilityRoute, path, manager, input, ctx, key);
    expect(first.body.data).toMatchObject({ state: visibility, version: version + 1 });
    expect((await post(visibilityRoute, path, manager, input, ctx, key)).body.data).toEqual(first.body.data);
    expectNoticeDenied(await post(visibilityRoute, path, manager,
      { visibility, expectedVersion: version + 1 }, ctx), 409, "STATE_CONFLICT");
  }
  const { rows } = await target.client.query(`SELECT action_type, actor_id, target_type, public_reason, before_state, after_state
    FROM audit_logs WHERE target_id = $1 ORDER BY (after_state->>'version')::int`, [noticeId]);
  expect(rows).toEqual([
    { action_type: "notice.hidden", actor_id: id(manager), target_type: "notice", public_reason: null,
      before_state: { publicationState: "public", version: 1 }, after_state: { publicationState: "hidden", version: 2 } },
    { action_type: "notice.restored", actor_id: id(manager), target_type: "notice", public_reason: null,
      before_state: { publicationState: "hidden", version: 2 }, after_state: { publicationState: "public", version: 3 } },
  ]);
  expect((await ownerNotifications()).rows).toEqual(before.rows);
});

it("Issue #14 AC-02 編集承認では申請版だけを審査し、公開版を更新しても強制非表示と初回公開日時を保つ", async () => {
  const { id: noticeId, requestId } = await addNotice({ hidden: true, pendingStatus: "pending" });
  const path = `${adminRequestsPath}/${requestId}`;
  const ctx = noticeContext(noticeId);
  const { rows: [before] } = await target.client.query(
    "SELECT first_published_at, forced_hidden_at FROM notices WHERE id = $1", [noticeId]);
  const review = await get(adminRequestRoute, path, "poc_school", requestContext(requestId!));
  expect(review.body.data?.content).toMatchObject({ body: `${marker} 申請本文` });
  expect(review.text).not.toContain("公開本文");
  expect((await post(decisionRoute, path + "/decision", "poc_school",
    { expectedVersion: 1, decision: "approve" }, requestContext(requestId!))).body.data?.state).toBe("approved");
  const { rows: [after] } = await target.client.query(
    "SELECT first_published_at, forced_hidden_at FROM notices WHERE id = $1", [noticeId]);
  expect(after).toEqual(before);
  expect((await get(managedNoticeRoute, `${managedNoticesPath}/${noticeId}`, "poc_school", ctx)).body.data).toMatchObject({
    publicationState: "hidden", publicContent: { body: `${marker} 申請本文` }, pendingRequest: null,
  });
  expectNoticeDenied(await get(noticeRoute, `/api/v1/notices/${noticeId}`, "poc_s001", ctx), 404, "NOT_FOUND");
});

it("Issue #14 AC-04 削除本体は保存期間中の学校管理者に限り閲覧でき、復元・期限後の申請取得を拒否する", async () => {
  const retained = await addNotice({ deletedAt: new Date(Date.now() - 179 * day), pendingStatus: "rejected" });
  const expired = await addNotice({ deletedAt: new Date(Date.now() - 180 * day), pendingStatus: "rejected", title: `${marker} 期限切れ` });
  const path = `${managedNoticesPath}/${retained.id}`;
  const ctx = noticeContext(retained.id);
  const list = await get(managedNoticesRoute, managedNoticesPath + "?state=deleted", "poc_school", {});
  expect(list.body.data?.items).toContainEqual(expect.objectContaining({ id: retained.id, publicationState: "deleted" }));
  expect(list.text).not.toContain(expired.id);
  expect((await get(managedNoticeRoute, path, "poc_school", ctx)).body.data).toMatchObject({
    publicationState: "deleted", deletedContent: { body: `${marker} 公開本文` },
    publicContent: null, capabilities: { canRestore: false },
  });
  expectNoticeDenied(await get(managedNoticeRoute, path, "poc_s_mgr", ctx), 404, "NOT_FOUND");
  expectNoticeDenied(await get(managedNoticesRoute, managedNoticesPath + "?state=deleted", "poc_s_mgr", {}), 403, "FORBIDDEN");
  for (const visibility of ["hidden", "public"]) {
    const input = { visibility, expectedVersion: 1 };
    expectNoticeDenied(await post(visibilityRoute, path + "/visibility", "poc_school", input, ctx), 409, "STATE_CONFLICT");
    expectNoticeDenied(await post(visibilityRoute, path + "/visibility", "poc_s_mgr", input, ctx), 404, "NOT_FOUND");
    expectNoticeDenied(await post(visibilityRoute, `${managedNoticesPath}/${expired.id}/visibility`, "poc_school",
      input, noticeContext(expired.id)), 404, "NOT_FOUND");
  }
  expectNoticeDenied(await get(managedNoticeRoute, `${managedNoticesPath}/${expired.id}`, "poc_school", noticeContext(expired.id)), 404, "NOT_FOUND");
  expectNoticeDenied(await get(adminRequestRoute, `${adminRequestsPath}/${expired.requestId}`, "poc_school",
    requestContext(expired.requestId!)), 404, "NOT_FOUND");
  expectNoticeDenied(await get(adminRequestRoute, `${adminRequestsPath}/${retained.requestId}`, "poc_s_mgr",
    requestContext(retained.requestId!)), 404, "NOT_FOUND");
});

it("Issue #14 削除済みのお知らせの再送は保存期間内に閲覧できる学校管理者に限り、状態を変更しない", async () => {
  const { id: noticeId } = await addNotice();
  const path = `${managedNoticesPath}/${noticeId}/visibility`;
  const ctx = noticeContext(noticeId);
  const hide = { visibility: "hidden", expectedVersion: 1 };
  const restore = { visibility: "public", expectedVersion: 2 };
  const hideKey = randomUUID();
  const restoreKey = randomUUID();
  expect((await post(visibilityRoute, path, "poc_s_mgr", hide, ctx, hideKey)).status).toBe(200);
  const restored = await post(visibilityRoute, path, "poc_school", restore, ctx, restoreKey);
  expect(restored.status).toBe(200);
  expect((await post(deletionRoute, `/api/v1/notices/${noticeId}/deletion`, "poc_a001",
    { expectedVersion: 3, confirmed: true }, ctx)).status).toBe(200);
  expectNoticeDenied(await post(visibilityRoute, path, "poc_s_mgr", hide, ctx, hideKey), 404, "NOT_FOUND");
  const replay = await post(visibilityRoute, path, "poc_school", restore, ctx, restoreKey);
  expect(replay.body.data).toEqual(restored.body.data);
  const { rows } = await target.client.query("SELECT count(*)::int AS count FROM audit_logs WHERE target_id = $1", [noticeId]);
  expect(rows).toEqual([{ count: 2 }]);
  await target.client.query("UPDATE notices SET deleted_at = now() - interval '180 days' WHERE id = $1", [noticeId]);
  expectNoticeDenied(await post(visibilityRoute, path, "poc_school", restore, ctx, restoreKey), 404, "NOT_FOUND");
});

it("SEC-01 未承認利用者はお知らせ一覧を拒否され、秘密情報を含む本文を受け取らない", async () => {
  const { id: noticeId } = await addNotice({ title: `${marker} 秘密題名`, body: `${marker} 秘密本文` });
  const userId = id("poc_s002");
  await target.client.query("UPDATE community_users SET eligibility_status = 'pending' WHERE user_id = $1", [userId]);
  try {
    const response = await get(noticesRoute, `/api/v1/notices?q=${encodeURIComponent(marker)}`, "poc_s002", {});
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe("ACCOUNT_NOT_READY");
    expect(response.body.data).toBeUndefined();
    expect(response.text).not.toContain("秘密題名");
    expect(response.text).not.toContain("秘密本文");
  } finally {
    await target.client.query("UPDATE community_users SET eligibility_status = 'verified' WHERE user_id = $1", [userId]);
  }
  expect((await get(noticeRoute, `/api/v1/notices/${noticeId}`, "poc_s002", noticeContext(noticeId))).status).toBe(200);
});

it("AC-01 公開版だけを検索・件数・詳細に含め、審査中は旧公開版を返す", async () => {
  const visible = await addNotice({
    title: `${marker} 旧公開タイトル`,
    body: `${marker} old-public-term`,
    pendingStatus: "pending",
  });
  const hidden = await addNotice({ title: `${marker} hidden title`, hidden: true });
  const deleted = await addNotice({ title: `${marker} deleted title`, deletedAt: new Date() });
  const unpublished = await addNotice({
    title: `${marker} unpublished title`, published: false, pendingStatus: "pending", requestKind: "new",
  });

  const publicSearch = await get(noticesRoute,
    `/api/v1/notices?q=${encodeURIComponent("old-public-term")}`, "poc_s002", {});
  expect(publicSearch.status).toBe(200);
  expect(titles(publicSearch.body)).toEqual([`${marker} 旧公開タイトル`]);
  expect(publicSearch.body.meta.page?.totalCount).toBe(1);
  const pendingSearch = await get(noticesRoute,
    `/api/v1/notices?q=${encodeURIComponent("申請本文")}`, "poc_s002", {});
  expect(pendingSearch.body.meta.page?.totalCount).toBe(0);
  expect(pendingSearch.text).not.toContain("申請本文");

  const detail = await get(noticeRoute, `/api/v1/notices/${visible.id}`, "poc_s002", noticeContext(visible.id));
  expect(detail.body.data).toMatchObject({
    id: visible.id,
    content: { title: `${marker} 旧公開タイトル`, body: `${marker} old-public-term` },
  });
  expect(detail.text).not.toContain("申請本文");
  for (const unavailable of [hidden, deleted, unpublished]) {
    expect((await get(noticeRoute, `/api/v1/notices/${unavailable.id}`, "poc_s002",
      noticeContext(unavailable.id))).status).toBe(404);
  }
});

it("AC-02 職員は即時公開、卒業生は審査申請となり、在校生は投稿できない", async () => {
  const content = { title: `${marker} 新規投稿`, body: "本文", categoryCode: "general" };
  const staff = await post(noticesRoute, "/api/v1/notices", "poc_staff", content, {});
  expect(staff.status).toBe(201);
  expect(staff.body.data?.state).toBe("public");
  const staffId = String((staff.body.data?.resource as { id: string }).id);
  createdNoticeIds.add(staffId);
  expect((await get(noticeRoute, `/api/v1/notices/${staffId}`, "poc_s002", noticeContext(staffId))).status).toBe(200);

  const alumni = await post(noticesRoute, "/api/v1/notices", "poc_a001", {
    ...content, title: `${marker} 卒業生申請`,
  }, {});
  expect(alumni.status).toBe(201);
  expect(alumni.body.data?.state).toBe("pending");
  const alumniResource = alumni.body.data?.resource as { type: string; id: string };
  expect(alumniResource.type).toBe("notice_request");
  expect(alumni.body.data?.version).toBe(1);
  const { rows: [{ notice_id: alumniId }] } = await target.client.query<{ notice_id: string }>(
    "SELECT notice_id FROM notice_requests WHERE id = $1", [alumniResource.id],
  );
  createdNoticeIds.add(alumniId);
  expect((await get(noticeRoute, `/api/v1/notices/${alumniId}`, "poc_s002", noticeContext(alumniId))).status).toBe(404);
  expect((await get(myNoticeRoute, `/api/v1/me/notices/${alumniId}`, "poc_a001", noticeContext(alumniId))).status).toBe(200);
  const { rows: notified } = await target.client.query<{ event_key: string }>(
    "SELECT event_key FROM notifications WHERE notice_request_id = $1", [alumniResource.id],
  );
  expect(notified.length).toBeGreaterThan(0);
  expect(new Set(notified.map(({ event_key }) => event_key)))
    .toEqual(new Set([`notice_review_requested:${alumniResource.id}:${alumniResource.id}`]));

  const student = await post(noticesRoute, "/api/v1/notices", "poc_s001", {
    ...content, title: `${marker} 不許可投稿`,
  }, {});
  expect(student.status).toBe(403);
  expect(student.body.error?.code).toBe("FORBIDDEN");
  expect(student.text).not.toContain("不許可投稿");
});

it("AC-03 公開後編集は職員が即時反映・卒業生が再審査となり、版番号・審査中の競合と再送を扱う", async () => {
  const content = { title: `${marker} 編集後題名`, body: `${marker} 編集後本文`, categoryCode: "general" };
  const revisionCount = async (noticeId: string) => (await target.client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM notice_revisions WHERE notice_id = $1", [noticeId],
  )).rows[0].total;

  const staffNotice = await addNotice({ author: "poc_staff" });
  const staffPath = `/api/v1/notices/${staffNotice.id}/revisions`;
  const key = randomUUID();
  const staffEdit = await post(revisionsRoute, staffPath, "poc_staff",
    { expectedVersion: 1, content }, noticeContext(staffNotice.id), key);
  expect(staffEdit.status).toBe(200);
  expect(staffEdit.body.data).toMatchObject({
    resource: { type: "notice", id: staffNotice.id }, version: 2, state: "public",
  });
  const replay = await post(revisionsRoute, staffPath, "poc_staff",
    { expectedVersion: 1, content }, noticeContext(staffNotice.id), key);
  expect(replay.status).toBe(200);
  expect(replay.body.data).toMatchObject({ operationId: staffEdit.body.data?.operationId, version: 2 });
  expect(await revisionCount(staffNotice.id)).toBe(2);
  const staffDetail = await get(noticeRoute, `/api/v1/notices/${staffNotice.id}`, "poc_s002",
    noticeContext(staffNotice.id));
  expect(staffDetail.body.data).toMatchObject({ content: { title: `${marker} 編集後題名` } });
  const stale = await post(revisionsRoute, staffPath, "poc_staff",
    { expectedVersion: 1, content }, noticeContext(staffNotice.id));
  expect(stale.status).toBe(409);
  expect(stale.body.error?.code).toBe("VERSION_CONFLICT");

  const hiddenNotice = await addNotice({ author: "poc_staff", hidden: true });
  const hiddenEdit = await post(revisionsRoute, `/api/v1/notices/${hiddenNotice.id}/revisions`, "poc_staff",
    { expectedVersion: 1, content }, noticeContext(hiddenNotice.id));
  expect(hiddenEdit.status).toBe(200);
  expect(hiddenEdit.body.data?.state).toBe("hidden");

  const alumniNotice = await addNotice();
  const alumniEdit = await post(revisionsRoute, `/api/v1/notices/${alumniNotice.id}/revisions`, "poc_a001",
    { expectedVersion: 1, content }, noticeContext(alumniNotice.id));
  expect(alumniEdit.status).toBe(200);
  const editRequest = alumniEdit.body.data?.resource as { type: string; id: string };
  expect(alumniEdit.body.data).toMatchObject({ resource: { type: "notice_request" }, version: 1, state: "pending" });
  const alumniDetail = await get(noticeRoute, `/api/v1/notices/${alumniNotice.id}`, "poc_s002",
    noticeContext(alumniNotice.id));
  expect(alumniDetail.body.data).toMatchObject({ content: { title: `${marker} 公開題名` } });
  const { rows: [{ total: notified }] } = await target.client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM notifications WHERE notice_request_id = $1", [editRequest.id],
  );
  expect(notified).toBeGreaterThan(0);

  const pendingNotice = await addNotice({ pendingStatus: "pending" });
  const pendingEdit = await post(revisionsRoute, `/api/v1/notices/${pendingNotice.id}/revisions`, "poc_a001",
    { expectedVersion: 1, content }, noticeContext(pendingNotice.id));
  expect(pendingEdit.status).toBe(409);
  expect(pendingEdit.body.error?.code).toBe("STATE_CONFLICT");
  expect(await revisionCount(pendingNotice.id)).toBe(2);
});

it("AC-04 取り下げ履歴を保ち、却下後の再申請は別レコードにする", async () => {
  const pending = await addNotice({ published: false, pendingStatus: "pending", requestKind: "new" });
  expect(pending.requestId).not.toBeNull();
  const withdrawn = await post(withdrawalRoute,
    `/api/v1/me/notice-requests/${pending.requestId}/withdrawal`, "poc_a001",
    { expectedVersion: 1 }, requestContext(pending.requestId!));
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body.data?.state).toBe("withdrawn");
  const history = await get(requestListRoute, `/api/v1/me/notices/${pending.id}/requests`,
    "poc_a001", noticeContext(pending.id));
  expect((history.body.data?.items ?? []).map((item) => item.status)).toContain("withdrawn");
  const detail = await get(requestRoute, `/api/v1/me/notice-requests/${pending.requestId}`,
    "poc_a001", requestContext(pending.requestId!));
  expect(detail.body.data?.capabilities).toMatchObject({ canWithdraw: false, canResubmit: false });

  const rejected = await addNotice({ published: false, pendingStatus: "rejected", requestKind: "new" });
  const oldId = rejected.requestId!;
  const resubmitted = await post(resubmissionRoute,
    `/api/v1/me/notice-requests/${oldId}/resubmission`, "poc_a001",
    { expectedVersion: 1, content: { title: `${marker} 修正済み`, body: "更新本文", categoryCode: "general" } },
    requestContext(oldId));
  expect(resubmitted.status).toBe(201);
  expect(resubmitted.body.data?.state).toBe("pending");
  expect(resubmitted.body.data?.resource).not.toMatchObject({ id: oldId });
  const { rows: requests } = await target.client.query<{ status: string; request_kind: string }>(
    "SELECT status, request_kind FROM notice_requests WHERE notice_id = $1 ORDER BY submitted_at, id",
    [rejected.id],
  );
  expect(requests.map(({ status }) => status)).toEqual(["rejected", "pending"]);
});

it("AC-05 プロフィール非表示中でも削除でき、審査中編集は自動で取り下げる", async () => {
  const record = await addNotice({ author: "poc_hidden", pendingStatus: "pending", version: 1 });
  const result = await post(deletionRoute, `/api/v1/notices/${record.id}/deletion`, "poc_hidden",
    { expectedVersion: 1, confirmed: true }, noticeContext(record.id));
  expect(result.status).toBe(200);
  expect(result.body.data?.state).toBe("deleted");
  const { rows: [noticeRequest] } = await target.client.query<{ status: string }>(
    "SELECT status FROM notice_requests WHERE id = $1", [record.requestId],
  );
  expect(noticeRequest.status).toBe("withdrawn");
  expect((await get(noticeRoute, `/api/v1/notices/${record.id}`, "poc_s002", noticeContext(record.id))).status).toBe(404);
  const ownerView = await get(myNoticeRoute, `/api/v1/me/notices/${record.id}`, "poc_hidden", noticeContext(record.id));
  expect(ownerView.body.data).toMatchObject({
    publicationState: "deleted", deletedContent: { title: `${marker} 公開題名` }, holdingState: null,
  });
  const active = await addNotice({ author: "poc_hidden" });
  const activeView = await get(myNoticeRoute, `/api/v1/me/notices/${active.id}`, "poc_hidden", noticeContext(active.id));
  expect(activeView.body.data).toMatchObject({ publicationState: "public", holdingState: null });
});

it("SEC-15 保存期限の到来後は、確定済みの更新を再送しても結果を返さない", async () => {
  const staffNotice = await addNotice({ author: "poc_staff" });
  const deletionKey = randomUUID();
  const deletionPath = `/api/v1/notices/${staffNotice.id}/deletion`;
  const deletionBody = { expectedVersion: 1, confirmed: true };
  const deleted = await post(deletionRoute, deletionPath, "poc_staff", deletionBody,
    noticeContext(staffNotice.id), deletionKey);
  expect(deleted.status).toBe(200);
  const retained = await post(deletionRoute, deletionPath, "poc_staff", deletionBody,
    noticeContext(staffNotice.id), deletionKey);
  expect(retained.status).toBe(200);
  expect(retained.body.data).toMatchObject({ operationId: deleted.body.data?.operationId, state: "deleted" });

  const alumniNotice = await addNotice();
  const editKey = randomUUID();
  const editPath = `/api/v1/notices/${alumniNotice.id}/revisions`;
  const editBody = {
    expectedVersion: 1, content: { title: `${marker} 期限前の編集`, body: `${marker} 期限前の本文`, categoryCode: "general" },
  };
  const edited = await post(revisionsRoute, editPath, "poc_a001", editBody, noticeContext(alumniNotice.id), editKey);
  expect(edited.status).toBe(200);
  expect(edited.body.data?.resource).toMatchObject({ type: "notice_request" });
  const alumniDeleted = await post(deletionRoute, `/api/v1/notices/${alumniNotice.id}/deletion`, "poc_a001",
    { expectedVersion: 2, confirmed: true }, noticeContext(alumniNotice.id));
  expect(alumniDeleted.status).toBe(200);

  await target.client.query("UPDATE notices SET deleted_at = now() - interval '180 days' WHERE id = ANY($1::uuid[])",
    [[staffNotice.id, alumniNotice.id]]);
  const expiredDeletion = await post(deletionRoute, deletionPath, "poc_staff", deletionBody,
    noticeContext(staffNotice.id), deletionKey);
  expect(expiredDeletion.status).toBe(404);
  expect(expiredDeletion.body.error?.code).toBe("NOT_FOUND");
  const expiredEdit = await post(revisionsRoute, editPath, "poc_a001", editBody, noticeContext(alumniNotice.id), editKey);
  expect(expiredEdit.status).toBe(404);
  expect(expiredEdit.text).not.toContain("期限前の本文");
});

it("卒業生から在校生へ訂正された後は、却下された申請の再申請を可能と返さない", async () => {
  const rejected = await addNotice({ published: false, pendingStatus: "rejected", requestKind: "new" });
  const detailPath = `/api/v1/me/notice-requests/${rejected.requestId}`;
  const before = await get(requestRoute, detailPath, "poc_a001", requestContext(rejected.requestId!));
  expect(before.body.data?.capabilities).toMatchObject({ canResubmit: true });

  const userId = id("poc_a001");
  await target.client.query("UPDATE community_users SET base_role = 'student' WHERE user_id = $1", [userId]);
  try {
    const request = await get(requestRoute, detailPath, "poc_a001", requestContext(rejected.requestId!));
    expect(request.body.data?.capabilities).toMatchObject({ canResubmit: false });
    const notice = await get(myNoticeRoute, `/api/v1/me/notices/${rejected.id}`, "poc_a001", noticeContext(rejected.id));
    expect(notice.body.data?.capabilities).toMatchObject({ canResubmit: false });
    const list = await get(myNoticesRoute, "/api/v1/me/notices?state=rejected", "poc_a001", {});
    const item = (list.body.data?.items ?? []).find((value) => value.id === rejected.id);
    expect(item?.capabilities).toMatchObject({ canResubmit: false });
    const resubmitted = await post(resubmissionRoute, `${detailPath}/resubmission`, "poc_a001",
      { expectedVersion: 1, content: { title: `${marker} 訂正後`, body: "本文", categoryCode: "general" } },
      requestContext(rejected.requestId!));
    expect(resubmitted.status).toBe(403);
  } finally {
    await target.client.query("UPDATE community_users SET base_role = 'alumni' WHERE user_id = $1", [userId]);
  }
});

it("公開内容の更新時刻は、審査を経た版では承認時刻、職員の直接公開では版の作成時刻を返す", async () => {
  const reviewed = await addNotice({ title: `${marker} 審査済み` });
  const { rows: [times] } = await target.client.query<{ created: Date; published: Date }>(`
    WITH revision AS (
      UPDATE notice_revisions SET created_at = now() - interval '2 days'
      WHERE id = (SELECT public_revision_id FROM notices WHERE id = $1)
      RETURNING created_at
    ), notice AS (
      UPDATE notices SET first_published_at = now() - interval '1 day' WHERE id = $1 RETURNING first_published_at
    )
    SELECT (SELECT created_at FROM revision) AS created, (SELECT first_published_at FROM notice) AS published
  `, [reviewed.id]);
  await target.client.query(`
    INSERT INTO notice_requests
      (notice_id, revision_id, request_kind, status, submitted_at, reviewer_id, decided_at, version)
    SELECT id, public_revision_id, 'new', 'approved', $2, $3, $4, 2 FROM notices WHERE id = $1
  `, [reviewed.id, times.created, id("poc_school"), times.published]);

  const detail = await get(noticeRoute, `/api/v1/notices/${reviewed.id}`, "poc_s002", noticeContext(reviewed.id));
  expect(detail.body.data).toMatchObject({
    firstPublishedAt: times.published.toISOString(), updatedAt: times.published.toISOString(),
  });
  const list = await get(noticesRoute, `/api/v1/notices?q=${encodeURIComponent(`${marker} 審査済み`)}`, "poc_s002", {});
  expect(list.body.data?.items?.[0]).toMatchObject({ id: reviewed.id, updatedAt: times.published.toISOString() });

  // 承認済み申請の一意性はDBで保証されない。同じ公開版に2件あっても一覧の行と件数をずらさない。
  const { rows: [{ decided: secondApproval }] } = await target.client.query<{ decided: Date }>(`
    INSERT INTO notice_requests
      (notice_id, revision_id, request_kind, status, submitted_at, reviewer_id, decided_at, version)
    SELECT id, public_revision_id, 'edit', 'approved', $2, $3, now() - interval '12 hours', 2 FROM notices WHERE id = $1
    RETURNING decided_at AS decided
  `, [reviewed.id, times.created, id("poc_school")]);
  const duplicated = await get(noticesRoute,
    `/api/v1/notices?q=${encodeURIComponent(`${marker} 審査済み`)}`, "poc_s002", {});
  expect(duplicated.body.data?.items).toHaveLength(1);
  expect(duplicated.body.meta.page?.totalCount).toBe(1);
  expect(duplicated.body.data?.items?.[0]).toMatchObject({ id: reviewed.id, updatedAt: secondApproval.toISOString() });

  const direct = await addNotice({ author: "poc_staff" });
  const { rows: [{ created }] } = await target.client.query<{ created: Date }>(
    "SELECT r.created_at AS created FROM notices n JOIN notice_revisions r ON r.id = n.public_revision_id WHERE n.id = $1",
    [direct.id],
  );
  const directDetail = await get(noticeRoute, `/api/v1/notices/${direct.id}`, "poc_s002", noticeContext(direct.id));
  expect(directDetail.body.data).toMatchObject({ updatedAt: created.toISOString() });
});

it("SEC-14 アプリ管理者は他人の削除済みお知らせ本文を閲覧できない", async () => {
  const record = await addNotice({ deletedAt: new Date(), title: `${marker} deleted secret` });
  const response = await get(myNoticeRoute, `/api/v1/me/notices/${record.id}`, "poc_s_mgr", noticeContext(record.id));
  expect(response.status).toBe(404);
  expect(response.body.error?.code).toBe("NOT_FOUND");
  expect(response.text).not.toContain("deleted secret");
});

it("SEC-15 180日経過後は本人一覧・詳細・申請履歴から本文を返さない", async () => {
  const expired = await addNotice({ deletedAt: new Date(Date.now() - 180 * day), pendingStatus: "withdrawn" });
  await target.client.query("UPDATE notices SET deleted_at = now() - interval '180 days' WHERE id = $1", [expired.id]);
  const list = await get(myNoticesRoute, "/api/v1/me/notices?state=deleted", "poc_a001", {});
  expect(list.status).toBe(200);
  expect((list.body.data?.items ?? []).some((item) => item.id === expired.id)).toBe(false);
  for (const response of [
    await get(myNoticeRoute, `/api/v1/me/notices/${expired.id}`, "poc_a001", noticeContext(expired.id)),
    await get(requestListRoute, `/api/v1/me/notices/${expired.id}/requests`, "poc_a001", noticeContext(expired.id)),
    await get(requestRoute, `/api/v1/me/notice-requests/${expired.requestId}`, "poc_a001", requestContext(expired.requestId!)),
  ]) {
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("申請本文");
    expect(response.text).not.toContain("公開本文");
  }
});

it("SEC-01 未認証・停止中の利用者にカテゴリーと一覧の内容を返さない", async () => {
  await addNotice({ title: `${marker} access secret` });
  const calls = [
    () => get(categoriesRoute, "/api/v1/notice-categories", null, {}),
    () => get(noticesRoute, "/api/v1/notices", "poc_suspended", {}),
  ];
  for (const call of calls) {
    const response = await call();
    expect(response.status).toBe(response.body.error?.code === "AUTH_REQUIRED" ? 401 : 403);
    expect(response.body.data).toBeUndefined();
    expect(response.text).not.toContain("access secret");
  }
});
