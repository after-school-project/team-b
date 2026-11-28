import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { handoffCasesAssignedTo, restrictCasesForNewAppManager } from "../../src/api/report-handoff";
import * as caseRoute from "../../src/app/api/v1/admin/report-cases/[caseId]/route";
import { GET as actions } from "../../src/app/api/v1/admin/report-cases/[caseId]/actions/route";
import { POST as assign } from "../../src/app/api/v1/admin/report-cases/[caseId]/assignment/route";
import { GET as candidates } from "../../src/app/api/v1/admin/report-cases/[caseId]/assignment-candidates/route";
import { GET as evidenceList } from "../../src/app/api/v1/admin/report-cases/[caseId]/evidence/route";
import { GET as evidenceDetail } from "../../src/app/api/v1/admin/report-cases/[caseId]/evidence/[evidenceId]/route";
import { POST as note } from "../../src/app/api/v1/admin/report-cases/[caseId]/notes/route";
import { GET as submissions } from "../../src/app/api/v1/admin/report-cases/[caseId]/reports/route";
import { GET as handoffs } from "../../src/app/api/v1/admin/report-cases/handoffs/route";
import { GET as list } from "../../src/app/api/v1/admin/report-cases/route";
import { POST as qaVisibility } from "../../src/app/api/v1/admin/questions/[questionId]/visibility/route";
import { POST as hideProfile } from "../../src/app/api/v1/admin/users/[userId]/profile-hiding/route";
import { POST as deleteQuestion } from "../../src/app/api/v1/questions/[questionId]/deletion/route";
import * as reportRoute from "../../src/app/api/v1/reports/route";
import { communityUsers } from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const author = "poc_s001";
const reporter = "poc_s002";
const otherReporter = "poc_hidden";
const manager = "poc_s_mgr";
const otherManager = "poc_a_mgr";
const school = "poc_school";
const staff = "poc_staff";
const suspended = "poc_suspended";
const intake = "/api/v1/reports";
const cases = "/api/v1/admin/report-cases";
const reportReason = "通報の検証用詳細";
const internalNote = "対応履歴の検証用メモ";
const postBody = "証拠に残す検証用本文";

let database: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let seedDir: string;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  database = await isolatedDatabase();
  await migrateDatabase(database.client);
  pool = new Pool({ connectionString: database.url.toString() });
  seedDir = await mkdtemp(join(tmpdir(), "team-b-report-cases-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(database.client), seedDir);
  const credentials: Record<string, string> = JSON.parse(await readFile(join(seedDir, "accounts.json"), "utf8"));
  const { POST: signIn } = await import("../../src/app/api/auth/[...auth]/route");
  for (const [index, username] of [author, reporter, otherReporter, manager, otherManager, school, staff, suspended].entries()) {
    const { rows: [account] } = await database.client.query<{ id: string }>('SELECT id FROM "user" WHERE username = $1', [username]);
    ids.set(username, account.id);
    const response = await signIn(new Request(`${origin}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${index + 1}` },
      body: JSON.stringify({ username, password: credentials[username] }),
    }));
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()
      .find((value) => value.startsWith("__Secure-better-auth.session_token="))?.split(";", 1)[0];
    if (!cookie) throw new Error("通報テストのセッションを発行できませんでした。");
    cookies.set(username, cookie);
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (seedDir) await rm(seedDir, { recursive: true, force: true });
  await database?.dispose();
});

function userId(username: string) { return ids.get(username)!; }

function request(viewer: string, path: string, method = "GET", body?: object, key = randomUUID()) {
  const headers = new Headers({ Cookie: cookies.get(viewer)! });
  if (body === undefined) return new Request(origin + path, { method, headers });
  headers.set("Origin", origin);
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", key);
  return new Request(origin + path, { method, headers, body: JSON.stringify(body) });
}

async function read<T = unknown>(response: Response) {
  const text = await response.text();
  const body: { data?: T; error?: { code: string }; meta?: { page?: { totalCount: number; nextCursor: string }; replayed?: boolean } }
    = JSON.parse(text);
  return { status: response.status, body, text };
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

async function post(viewer: string, type: string, id: string, more: object = {}, key?: ReturnType<typeof randomUUID>) {
  return read<{ received: true; receivedAt: string }>(await reportRoute.POST(request(viewer, intake, "POST", {
    target: { type, id }, reason: "spam", detail: reportReason, confirmed: true, ...more,
  }, key), undefined));
}

async function addQuestion(username = author, deleted = false) {
  const { rows: [row] } = await database.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, deleted_at)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = 'learning'), '通報対象の質問', $2,
      '検証用の投稿者', CASE WHEN $3 THEN now() END) RETURNING id
  `, [userId(username), postBody, deleted]);
  return row.id;
}

type CaseRow = { id: string; status: "unhandled" | "in_progress" | "closed"; version: number;
  assigneeId: string | null; handoffPending: boolean; schoolOnly: boolean; closedAt: Date | null };

async function getCase(questionId: string) {
  const { rows: [row] } = await database.client.query<CaseRow>(`
    SELECT report_cases.id, status, version, assignee_id AS "assigneeId", school_only AS "schoolOnly",
      handoff_pending AS "handoffPending", closed_at AS "closedAt" FROM report_cases
    JOIN report_targets ON report_targets.id = report_cases.target_id
    WHERE question_id = $1 ORDER BY report_cases.created_at DESC LIMIT 1
  `, [questionId]);
  return row;
}

async function fileCase(questionId: string) {
  expect((await post(reporter, "question", questionId)).status).toBe(201);
  return getCase(questionId);
}

async function readCase<T>(viewer: string, caseId: string, route = caseRoute.GET, segment = "") {
  return read<T>(await route(request(viewer, `${cases}/${caseId}${segment}`), params({ caseId })));
}

async function patch(viewer: string, row: CaseRow, body: object, key?: ReturnType<typeof randomUUID>) {
  return read(await caseRoute.PATCH(request(viewer, `${cases}/${row.id}`, "PATCH", { expectedVersion: row.version, ...body }, key),
    params({ caseId: row.id })));
}

async function assignment(viewer: string, row: CaseRow, username: string) {
  return read(await assign(request(viewer, `${cases}/${row.id}/assignment`, "POST", {
    expectedVersion: row.version, assigneeId: userId(username),
  }), params({ caseId: row.id })));
}

async function addNote(viewer: string, row: CaseRow) {
  return read(await note(request(viewer, `${cases}/${row.id}/notes`, "POST", { expectedVersion: row.version, note: internalNote }),
    params({ caseId: row.id })));
}

async function removeQuestion(questionId: string) {
  return read(await deleteQuestion(request(author, `/api/v1/questions/${questionId}/deletion`, "POST", {
    expectedVersion: 1, confirmed: true,
  }), params({ questionId })));
}

async function getEvidence(viewer: string, caseId: string, evidenceId: string) {
  return read(await evidenceDetail(request(viewer, `${cases}/${caseId}/evidence/${evidenceId}`), params({ caseId, evidenceId })));
}

it("AC-01 / SEC-24 対象・理由・文字数・最終確認を検証し、通報者には受付だけを返す", async () => {
  const questionId = await addQuestion();
  for (const body of [{ confirmed: false }, { reason: "unknown" }, { reason: "other", detail: "　 \t" }, { detail: "😀".repeat(501) }]) {
    expect((await post(reporter, "question", questionId, body)).status).toBe(422);
  }
  for (const type of ["notice", "event"]) {
    const denied = await post(reporter, type, questionId);
    expect(denied.status).toBe(422);
    expect(denied.text).not.toContain(reportReason);
  }
  const schoolQuestion = await addQuestion(school);
  const deleted = await addQuestion(author, true);
  for (const [viewer, type, id] of [[author, "question", questionId], [reporter, "question", schoolQuestion],
    [reporter, "account", userId(school)], [reporter, "profile", userId(otherReporter)], [reporter, "question", deleted]]) {
    const denied = await post(viewer, type, id);
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain(postBody);
  }
  const key = randomUUID();
  const valid = { reason: "other", detail: "😀".repeat(500) };
  const rejected = await post(suspended, "question", questionId, valid);
  expect(rejected.status).toBe(403);
  expect(rejected.body.error?.code).toBe("ACCOUNT_SUSPENDED");
  expect(rejected.text).not.toContain(postBody);
  const first = await post(otherReporter, "question", questionId, valid, key);
  expect(first.status).toBe(201);
  expect(first.body.data).toEqual({ received: true, receivedAt: expect.stringMatching(/Z$/) });
  const replay = await post(otherReporter, "question", questionId, valid, key);
  expect(replay.body.data).toEqual(first.body.data);
  expect(replay.body.meta?.replayed).toBe(true);
  expect((await post(otherReporter, "question", questionId, { detail: "別の内容" }, key)).body.error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
  for (const [method, handler] of [["GET", reportRoute.GET], ["PATCH", reportRoute.PATCH], ["DELETE", reportRoute.DELETE]] as const) {
    expect((await handler(request(reporter, intake, method), undefined)).status).toBe(405);
  }
});

it("AC-02 並行受付を1件に統合し、通報・証拠・関連を保存し、完了後の通報は新しい案件にする", async () => {
  const questionId = await addQuestion();
  const results = await Promise.all([post(reporter, "question", questionId), post(otherReporter, "question", questionId)]);
  expect(results.map(({ status }) => status)).toEqual([201, 201]);
  const row = await getCase(questionId);
  expect(row.assigneeId).toBe(userId(school));
  const { rows: [counts] } = await database.client.query(`SELECT
    (SELECT count(*)::int FROM reports WHERE case_id = $1) AS reports,
    (SELECT count(*)::int FROM report_case_evidence WHERE case_id = $1) AS evidence`, [row.id]);
  expect(counts).toEqual({ reports: 2, evidence: 1 });
  expect((await patch(school, row, { status: "closed" })).status).toBe(200);
  const next = await fileCase(questionId);
  expect(next.id).not.toBe(row.id);
  expect(next.status).toBe("unhandled");
});

it("AC-02 証拠の保存に失敗した受付は全体を取り消し、同じ再送キーで確定できる", async () => {
  const questionId = await addQuestion();
  const key = randomUUID();
  await database.client.query("ALTER TABLE evidence_snapshots ADD CONSTRAINT reject_report_intake_test CHECK (false) NOT VALID");
  try {
    const failed = await post(reporter, "question", questionId, {}, key);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(postBody);
    expect(failed.text).not.toContain(reportReason);
    const { rowCount } = await database.client.query("SELECT 1 FROM report_targets WHERE question_id = $1", [questionId]);
    expect(rowCount).toBe(0);
  } finally {
    await database.client.query("ALTER TABLE evidence_snapshots DROP CONSTRAINT reject_report_intake_test");
  }
  const retry = await post(reporter, "question", questionId, {}, key);
  expect(retry.status).toBe(201);
  expect(retry.body.meta?.replayed).toBeUndefined();
});

it("AC-02 初期担当を割り当てられない通報も、学校専用の引継ぎ待ちとして受け付ける", async () => {
  const questionId = await addQuestion();
  await database.client.query("UPDATE community_users SET school_manager = false WHERE user_id = $1", [userId(school)]);
  let row: CaseRow;
  try {
    row = await fileCase(questionId);
  } finally {
    await database.client.query("UPDATE community_users SET school_manager = true WHERE user_id = $1", [userId(school)]);
  }
  expect(row).toMatchObject({ schoolOnly: true, handoffPending: true, assigneeId: null });
  expect((await readCase(manager, row.id)).status).toBe(404);
  expect((await readCase(school, row.id)).status).toBe(200);
  expect((await assignment(school, row, school)).status).toBe(200);
  expect((await patch(school, await getCase(questionId), { status: "closed" })).status).toBe(200);
});

it("学校管理者の通報は別の有資格者を初期担当にし、該当者がいなければ引継ぎ待ちにする", async () => {
  const noCandidate = await addQuestion();
  expect((await post(school, "question", noCandidate)).status).toBe(201);
  const waiting = await getCase(noCandidate);
  expect(waiting).toMatchObject({ assigneeId: null, handoffPending: true, schoolOnly: true });
  expect((await patch(school, waiting, { status: "closed" })).status).toBe(200);

  await database.client.query("UPDATE community_users SET school_manager = true WHERE user_id = $1", [userId(staff)]);
  try {
    const questionId = await addQuestion();
    expect((await post(school, "question", questionId)).status).toBe(201);
    expect(await getCase(questionId)).toMatchObject({ assigneeId: userId(staff), handoffPending: false, schoolOnly: false });
  } finally {
    await database.client.query("UPDATE community_users SET school_manager = false WHERE user_id = $1", [userId(staff)]);
  }
});

it("受付の利用者ロック待ちで初期担当候補が資格を失ったら、別の学校管理者に割り当てる", async () => {
  const questionId = await addQuestion();
  const secondSchoolManager = userId(staff);
  await database.client.query("UPDATE community_users SET school_manager = true WHERE user_id = $1", [secondSchoolManager]);
  const { rows: [first, second] } = await database.client.query<{ user_id: string }>(
    "SELECT user_id FROM community_users WHERE school_manager ORDER BY user_id",
  );
  let pending: ReturnType<typeof post> | undefined;
  let inTransaction = false;
  try {
    await database.client.query("BEGIN");
    inTransaction = true;
    await database.client.query("SELECT user_id FROM community_users WHERE user_id = $1 FOR UPDATE", [first.user_id]);
    pending = post(reporter, "question", questionId);
    let blocked = false;
    const deadline = Date.now() + 1500;
    while (!blocked && Date.now() < deadline) {
      const { rows: [row] } = await database.client.query<{ blocked: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked
      `);
      blocked = row.blocked;
      if (!blocked) await delay(15);
    }
    expect(blocked).toBe(true);
    await database.client.query("UPDATE community_users SET eligibility_status = 'pending' WHERE user_id = $1", [first.user_id]);
    await database.client.query("COMMIT");
    inTransaction = false;
    expect((await pending).status).toBe(201);
    expect(await getCase(questionId)).toMatchObject({ assigneeId: second.user_id, handoffPending: false, schoolOnly: false });
  } finally {
    if (inTransaction) await database.client.query("ROLLBACK");
    await pending;
    await database.client.query("UPDATE community_users SET eligibility_status = 'verified' WHERE user_id = $1", [first.user_id]);
    await database.client.query("UPDATE community_users SET school_manager = false WHERE user_id = $1", [secondSchoolManager]);
  }
});

it("AC-02 プロフィールとアカウントの証拠を公開項目に限定し、回答は親の本文を含めない", async () => {
  const questionId = await addQuestion(author, true);
  const { rows: [answer] } = await database.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, author_label, kind, body_markdown)
    VALUES ($1, $2, '検証用の回答者', 'answer', '検証用の残存回答') RETURNING id
  `, [questionId, userId(author)]);
  for (const [type, id] of [["profile", userId(author)], ["account", userId(author)], ["response", answer.id]]) {
    expect((await post(reporter, type, id)).status).toBe(201);
  }
  const { rows } = await database.client.query<{ kind: string; snapshot: object }>(`
    SELECT kind, snapshot FROM evidence_snapshots JOIN report_targets ON target_id = report_targets.id
    WHERE subject_user_id = $1 OR response_id = $2 ORDER BY kind
  `, [userId(author), answer.id]);
  expect(rows.map(({ kind }) => kind)).toEqual(["account", "profile", "response"]);
  expect(Object.keys(rows[0].snapshot).sort()).toEqual(["baseRole", "displayName", "userId"]);
  expect(rows[1].snapshot).toMatchObject({ fields: { optionalFields: { bio: { visibility: "members" } } } });
  expect(rows[1].snapshot).not.toMatchObject({ fields: { optionalFields: { interests: expect.anything() } } });
  expect(rows[2].snapshot).toMatchObject({ questionId, bodyMarkdown: "検証用の残存回答" });
  expect(JSON.stringify(rows)).not.toContain(postBody);
});

it("AC-03 / SEC-19 / SEC-20 通常案件だけをアプリ管理者に公開し、通報者情報は公開名とIDに絞る", async () => {
  const ordinary = await fileCase(await addQuestion());
  const schoolOnly = await fileCase(await addQuestion(otherManager));
  expect(schoolOnly.schoolOnly).toBe(true);
  const denied = await readCase(author, ordinary.id, submissions, "/reports");
  expect(denied.status).toBe(403);
  expect(denied.text).not.toContain(userId(reporter));
  expect(denied.text).not.toContain(reportReason);
  const visible = await readCase<{ items: { reporter: object }[] }>(manager, ordinary.id, submissions, "/reports");
  expect(visible.status).toBe(200);
  expect(visible.body.data?.items[0].reporter).toEqual({ userId: userId(reporter), displayName: expect.any(String) });
  expect(visible.text).not.toContain("email");
  const withheld = await readCase(otherManager, schoolOnly.id, submissions, "/reports");
  expect(withheld.status).toBe(404);
  expect(withheld.text).not.toContain(userId(reporter));
  expect(withheld.text).not.toContain(reportReason);
  const query = `?targetType=question&status=unhandled&priority=unset&assigneeId=${encodeURIComponent(userId(school))}&limit=1`;
  const appList = await read<{ items: { id: string }[] }>(await list(request(manager, cases + query), undefined));
  const schoolList = await read(await list(request(school, cases + query), undefined));
  expect(appList.body.data?.items.map(({ id }) => id)).not.toContain(schoolOnly.id);
  expect(schoolList.body.meta?.page?.totalCount).toBe(appList.body.meta!.page!.totalCount + 1);
  expect((await readCase(school, schoolOnly.id)).status).toBe(200);
});

it("通報案件一覧では未対応が既定で、status=all なら対応中と対応済みも含む", async () => {
  const unhandled = await fileCase(await addQuestion());
  const inProgress = await fileCase(await addQuestion());
  const closed = await fileCase(await addQuestion());
  expect((await patch(school, unhandled, { priority: "high" })).status).toBe(200);
  expect((await patch(school, inProgress, { status: "in_progress", priority: "high" })).status).toBe(200);
  expect((await patch(school, closed, { status: "closed", priority: "high" })).status).toBe(200);
  const getList = async (query: string) => read<{ items: { id: string }[] }>(
    await list(request(school, `${cases}?targetType=question&priority=high${query}`), undefined),
  );
  const defaultList = await getList("");
  expect(defaultList.body.data?.items.map(({ id }) => id)).toEqual([unhandled.id]);
  expect(defaultList.body.meta?.page?.totalCount).toBe(1);
  const all = await getList("&status=all");
  expect(all.body.data?.items.map(({ id }) => id)).toEqual([closed.id, inProgress.id, unhandled.id]);
  expect(all.body.meta?.page?.totalCount).toBe(3);
});

it("引継ぎ待ちは未対応と対応中を作成日時・IDの昇順で取得し、カーソルで次の案件へ進む", async () => {
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await fileCase(await addQuestion()));
  const tied = [rows[1].id, rows[2].id].sort();
  const expected = [rows[0].id, ...tied];
  for (const [index, id] of expected.entries()) {
    await database.client.query(`UPDATE report_cases
      SET created_at = $2, updated_at = $3, status = $4, priority = 'high', handoff_pending = true, assignee_id = null
      WHERE id = $1`, [id, index === 0 ? "2026-01-01T00:00:00.000001Z" : "2026-01-01T00:00:00.000002Z",
      `2026-01-0${5 - index}T00:00:00Z`, index === 1 ? "in_progress" : "unhandled"]);
  }
  let cursor: string | undefined;
  for (const [index, id] of expected.entries()) {
    const path = `${cases}/handoffs?priority=high&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await read<{ items: { id: string }[] }>(await handoffs(request(school, path), undefined));
    expect(page.status).toBe(200);
    expect(page.body.data?.items.map((item) => item.id)).toEqual([id]);
    expect(page.body.meta?.page?.totalCount).toBe(3);
    cursor = page.body.meta?.page?.nextCursor;
    expect(Boolean(cursor)).toBe(index < expected.length - 1);
  }
});

it("AC-04 版が競合した更新を拒否し、措置・メモ・案件完了と履歴を確定する", async () => {
  const questionId = await addQuestion();
  const row = await fileCase(questionId);
  const updates = await Promise.all([patch(manager, row, { priority: "high" }), patch(school, row, { status: "in_progress" })]);
  expect(updates.map(({ status }) => status).sort()).toEqual([200, 409]);
  expect(updates.find(({ status }) => status === 409)?.body.error?.code).toBe("VERSION_CONFLICT");
  expect((await addNote(manager, await getCase(questionId))).status).toBe(200);
  const hidden = await qaVisibility(request(manager, `/api/v1/admin/questions/${questionId}/visibility`, "POST", {
    expectedVersion: 1, visibility: "hidden", reason: "公開範囲の検証", sourceCaseId: row.id,
  }), params({ questionId }));
  expect(hidden.status).toBe(200);
  const current = await getCase(questionId);
  const key = randomUUID();
  expect((await patch(manager, current, { status: "closed" }, key)).status).toBe(200);
  expect((await patch(manager, current, { status: "closed" }, key)).body.meta?.replayed).toBe(true);
  const closed = await getCase(questionId);
  expect(closed.status).toBe("closed");
  expect((await patch(manager, closed, { status: "unhandled" })).body.error?.code).toBe("CASE_CLOSED");
  expect((await addNote(manager, closed)).body.error?.code).toBe("CASE_CLOSED");
  expect((await assignment(manager, closed, manager)).body.error?.code).toBe("CASE_CLOSED");
  const history = await readCase<{ items: { actionType: string }[] }>(school, row.id, actions, "/actions");
  expect(history.body.data?.items.map(({ actionType }) => actionType)).toEqual(["case_closed", "qa_hidden", "note_added", "case_updated"]);
  expect(history.text).toContain(internalNote);
  const { rowCount } = await database.client.query("SELECT 1 FROM audit_logs WHERE target_id = $1 AND action_type = 'report_case.closed'", [row.id]);
  expect(rowCount).toBe(1);
});

it("現在の担当者が資格を失っていても、別の有資格者は担当を変えずにメモ・状態更新・完了ができる", async () => {
  const questionId = await addQuestion();
  const initial = await fileCase(questionId);
  await database.client.query("UPDATE community_users SET eligibility_status = 'pending' WHERE user_id = $1", [userId(school)]);
  try {
    expect((await addNote(manager, initial)).status).toBe(200);
    expect((await patch(manager, await getCase(questionId), { status: "in_progress", priority: "high" })).status).toBe(200);
    expect((await patch(manager, await getCase(questionId), { status: "closed" })).status).toBe(200);
    expect(await getCase(questionId)).toMatchObject({ assigneeId: userId(school), status: "closed", handoffPending: false });
  } finally {
    await database.client.query("UPDATE community_users SET eligibility_status = 'verified' WHERE user_id = $1", [userId(school)]);
  }
});

it("AC-05 / SEC-16 / SEC-27 削除した対象の案件を引き継ぎ、再割当と直接完了を学校管理者に限定する", async () => {
  for (const direct of [false, true]) {
    const questionId = await addQuestion();
    const row = await fileCase(questionId);
    const initialEvidence = await readCase<{ items: { id: string }[] }>(school, row.id, evidenceList, "/evidence");
    const evidenceId = initialEvidence.body.data!.items[0].id;
    expect((await patch(school, row, { status: "in_progress" })).status).toBe(200);
    expect((await assignment(school, await getCase(questionId), manager)).status).toBe(200);
    expect((await removeQuestion(questionId)).status).toBe(200);
    const waiting = await getCase(questionId);
    expect(waiting).toMatchObject({ status: "in_progress", handoffPending: true, assigneeId: null });
    const deniedEvidence = await getEvidence(manager, waiting.id, evidenceId);
    expect(deniedEvidence.status).toBe(404);
    expect(deniedEvidence.text).not.toContain(postBody);
    const deniedChange = await assignment(manager, waiting, manager);
    expect(deniedChange.status).toBe(404);
    expect(deniedChange.text).not.toContain(reportReason);
    expect((await read(await handoffs(request(manager, `${cases}/handoffs`), undefined))).status).toBe(403);
    const possible = await readCase<{ items: { userId: string }[] }>(school, waiting.id, candidates, "/assignment-candidates");
    expect(possible.body.data?.items.map((item) => item.userId)).toEqual([userId(school)]);
    if (direct) {
      expect((await patch(school, waiting, { status: "closed" })).status).toBe(200);
      expect(await getCase(questionId)).toMatchObject({ status: "closed", handoffPending: false, assigneeId: userId(school), closedAt: expect.any(Date) });
    } else {
      expect((await assignment(school, waiting, manager)).body.error?.code).toBe("ASSIGNEE_INELIGIBLE");
      expect((await assignment(school, waiting, school)).status).toBe(200);
      expect(await getCase(questionId)).toMatchObject({ status: "in_progress", handoffPending: false, assigneeId: userId(school) });
      const history = await readCase<{ items: { actionType: string }[] }>(school, waiting.id, actions, "/actions");
      expect(history.body.data?.items.map(({ actionType }) => actionType)).toEqual([
        "handoff_resolved", "handoff_started", "assignee_changed", "case_updated",
      ]);
    }
  }
});

it("AC-06 証拠の関連・180日・案件1年を独立に検証し、削除済みの引用をアプリ管理者へ返さない", async () => {
  const questionId = await addQuestion();
  const first = await fileCase(questionId);
  expect((await addNote(school, first)).status).toBe(200);
  expect((await patch(school, await getCase(questionId), { status: "closed" })).status).toBe(200);
  const second = await fileCase(questionId);
  const unrelated = await fileCase(await addQuestion());
  const { body } = await readCase<{ items: { id: string }[] }>(school, second.id, evidenceList, "/evidence");
  const evidenceId = body.data!.items[0].id;
  expect((await getEvidence(school, unrelated.id, evidenceId)).status).toBe(404);
  expect((await removeQuestion(questionId)).status).toBe(200);
  await database.client.query("UPDATE report_cases SET closed_at = now() - interval '200 days' WHERE id = $1", [first.id]);
  expect((await getEvidence(school, first.id, evidenceId)).body.data).toMatchObject({ retentionExpiresAt: null, sourceDeleted: true });
  const redacted = await readCase(manager, first.id, submissions, "/reports");
  expect(redacted.status).toBe(200);
  expect(redacted.body.data).toMatchObject({ items: [{ detail: null, detailRedacted: true }] });
  expect(redacted.text).not.toContain(reportReason);
  const history = await readCase(manager, first.id, actions, "/actions");
  expect(history.body.data).toMatchObject({ items: [expect.anything(), { note: null, noteRedacted: true }] });
  expect(history.text).not.toContain(internalNote);
  expect((await getEvidence(manager, first.id, evidenceId)).status).toBe(404);
  expect((await patch(school, await getCase(questionId), { status: "closed" })).status).toBe(200);
  await database.client.query("UPDATE report_cases SET closed_at = now() - interval '180 days' + interval '1 minute' WHERE id = $1", [second.id]);
  expect((await getEvidence(school, first.id, evidenceId)).status).toBe(200);
  await database.client.query("UPDATE report_cases SET closed_at = now() - interval '180 days' WHERE id = $1", [second.id]);
  expect((await getEvidence(school, first.id, evidenceId)).status).toBe(404);
  expect((await readCase(school, first.id, evidenceList, "/evidence")).body.meta?.page?.totalCount).toBe(0);
  expect((await readCase(school, first.id)).status).toBe(200);
  await database.client.query("UPDATE report_cases SET closed_at = now() - interval '1 year' WHERE id = $1", [first.id]);
  expect((await readCase(school, first.id)).status).toBe(404);
});

it("AC-05 #47 の停止・権限解除・学校専用化の記録を案件の閲覧・割当と結合する", async () => {
  const testDb = drizzle(pool);
  for (const trigger of ["manager_suspended", "manager_role_revoked", "subject_became_app_manager"] as const) {
    const questionId = await addQuestion();
    const row = await fileCase(questionId);
    expect((await assignment(school, row, manager)).status).toBe(200);
    const targetId = userId(trigger === "subject_became_app_manager" ? author : manager);
    try {
      await testDb.transaction(async (tx) => {
        const condition = eq(communityUsers.userId, targetId);
        await tx.select({ id: communityUsers.userId }).from(communityUsers).where(condition).for("update");
        const context = { tx, requireLockedUsers: (id: string) => expect(id).toBe(targetId) };
        // #16 のアカウント操作から呼ぶ共通処理を、利用資格の変更と同一のトランザクションで実行する。
        if (trigger === "subject_became_app_manager") {
          await tx.update(communityUsers).set({ appManager: true }).where(condition);
          await restrictCasesForNewAppManager(context, { userId: targetId });
        } else {
          await tx.update(communityUsers).set(trigger === "manager_suspended" ? { accountStatus: "suspended" } : { appManager: false })
            .where(condition);
          await handoffCasesAssignedTo(context, { managerId: targetId, trigger });
          expect((await readCase(otherManager, row.id)).status).toBe(200);
        }
      });
      const waiting = await getCase(questionId);
      expect(waiting).toMatchObject({ status: "unhandled", handoffPending: true, assigneeId: null });
      const denied = await readCase(otherManager, row.id, submissions, "/reports");
      expect(denied.status).toBe(404);
      expect(denied.text).not.toContain(reportReason);
      expect((await assignment(school, waiting, school)).status).toBe(200);
    } finally {
      await testDb.update(communityUsers).set({ accountStatus: "active", appManager: targetId === userId(manager) })
        .where(eq(communityUsers.userId, targetId));
    }
    if (trigger === "subject_became_app_manager") {
      expect((await getCase(questionId)).schoolOnly).toBe(true);
      expect((await readCase(manager, row.id)).status).toBe(404);
    }
  }
});

it("SEC-17 担当管理者のプロフィール非表示を案件一覧・引継ぎ待ち・割当候補に反映する", async () => {
  const questionId = await addQuestion();
  const row = await fileCase(questionId);
  expect((await assignment(school, row, otherManager)).status).toBe(200);
  const managerId = userId(otherManager);
  const hidden = await hideProfile(request(school, `/api/v1/admin/users/${encodeURIComponent(managerId)}/profile-hiding`, "POST", {
    expectedVersion: 1, reason: "プロフィールの表示を見直すため",
  }), params({ userId: managerId }));
  expect(hidden.status).toBe(200);
  const waiting = await getCase(questionId);
  expect(waiting).toMatchObject({ assigneeId: null, handoffPending: true, status: "unhandled" });
  const hiddenManager = await readCase(otherManager, row.id, submissions, "/reports");
  expect(hiddenManager.status).toBe(403);
  expect(hiddenManager.text).not.toContain(reportReason);
  expect(hiddenManager.text).not.toContain(userId(reporter));
  const handoffList = await read<{ items: { id: string }[] }>(await handoffs(request(school, `${cases}/handoffs`), undefined));
  expect(handoffList.body.data?.items.map(({ id }) => id)).toContain(row.id);
  expect((await assignment(school, waiting, otherManager)).body.error?.code).toBe("ASSIGNEE_INELIGIBLE");
  expect((await assignment(school, waiting, manager)).status).toBe(200);
});
