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
let myNoticesRoute: typeof import("../../src/app/api/v1/me/notices/route");
let myNoticeRoute: typeof import("../../src/app/api/v1/me/notices/[noticeId]/route");
let requestListRoute: typeof import("../../src/app/api/v1/me/notices/[noticeId]/requests/route");
let requestRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/route");
let withdrawalRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/withdrawal/route");
let resubmissionRoute: typeof import("../../src/app/api/v1/me/notice-requests/[requestId]/resubmission/route");
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
  myNoticesRoute = await import("../../src/app/api/v1/me/notices/route");
  myNoticeRoute = await import("../../src/app/api/v1/me/notices/[noticeId]/route");
  requestListRoute = await import("../../src/app/api/v1/me/notices/[noticeId]/requests/route");
  requestRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/route");
  withdrawalRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/withdrawal/route");
  resubmissionRoute = await import("../../src/app/api/v1/me/notice-requests/[requestId]/resubmission/route");
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

async function headersFor(viewer: string | null, mutation = false): Promise<HeadersInit> {
  return {
    ...(viewer ? { Cookie: await cookieFor(viewer) } : {}),
    ...(mutation ? {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
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
) {
  return parse(await route.POST(new Request(origin + path, {
    method: "POST",
    headers: await headersFor(viewer, true),
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
  const alumniId = String((alumni.body.data?.resource as { id: string }).id);
  createdNoticeIds.add(alumniId);
  expect((await get(noticeRoute, `/api/v1/notices/${alumniId}`, "poc_s002", noticeContext(alumniId))).status).toBe(404);
  expect((await get(myNoticeRoute, `/api/v1/me/notices/${alumniId}`, "poc_a001", noticeContext(alumniId))).status).toBe(200);
  const { rows: [{ total }] } = await target.client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM notifications WHERE notice_request_id IN (SELECT id FROM notice_requests WHERE notice_id = $1)",
    [alumniId],
  );
  expect(total).toBeGreaterThan(0);

  const student = await post(noticesRoute, "/api/v1/notices", "poc_s001", {
    ...content, title: `${marker} 不許可投稿`,
  }, {});
  expect(student.status).toBe(403);
  expect(student.body.error?.code).toBe("FORBIDDEN");
  expect(student.text).not.toContain("不許可投稿");
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
  expect(ownerView.body.data).toMatchObject({ publicationState: "deleted", deletedContent: { title: `${marker} 公開題名` } });
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
