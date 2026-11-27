import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { noCapabilities } from "../../src/auth/capabilities";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 質問・回答等の本人削除（#9 ⑤、API-QA-06・11）。実際の Route Handler を実セッションで呼ぶ。
 * AC-09：本人だけが版番号と確認付きで自分の投稿を削除でき、子の投稿は削除されず残存スレッドとして表示される。
 * AC-10：削除済みの本文・著者・版を権限外の利用者へ返さず、必要な通報証拠を削除の前に保全する。
 * 引継ぎ（共通認可条件表 §2、権限マトリクス 4.1）：削除した投稿の未終了案件のうち、アプリ管理者が担当する案件を引継ぎ待ちにする。
 */

const origin = "https://school.example";
/** このテストが追加する質問の本文に付ける文字列。seed の質問と区別する。 */
const marker = "削除の検証用データ";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let questionRoute: typeof import("../../src/app/api/v1/questions/[questionId]/route");
let questionDeletionRoute: typeof import("../../src/app/api/v1/questions/[questionId]/deletion/route");
let responsesRoute: typeof import("../../src/app/api/v1/questions/[questionId]/responses/route");
let responseRoute: typeof import("../../src/app/api/v1/responses/[responseId]/route");
let responseDeletionRoute: typeof import("../../src/app/api/v1/responses/[responseId]/deletion/route");
let ipCounter = 0;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-qa-deletion-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user" WHERE username IS NOT NULL');
  for (const { id, username } of rows) ids.set(username, id);
  questionRoute = await import("../../src/app/api/v1/questions/[questionId]/route");
  questionDeletionRoute = await import("../../src/app/api/v1/questions/[questionId]/deletion/route");
  responsesRoute = await import("../../src/app/api/v1/questions/[questionId]/responses/route");
  responseRoute = await import("../../src/app/api/v1/responses/[responseId]/route");
  responseDeletionRoute = await import("../../src/app/api/v1/responses/[responseId]/deletion/route");
});

afterEach(async () => {
  const questions = "SELECT id FROM qa_questions WHERE body_markdown LIKE $1";
  const responses = `SELECT id FROM qa_responses WHERE question_id IN (${questions})`;
  const targets = `SELECT id FROM report_targets WHERE response_id IN (${responses}) OR question_id IN (${questions})`;
  const cases = `SELECT id FROM report_cases WHERE target_id IN (${targets})`;
  const values = [`%${marker}%`];
  await target.client.query(`DELETE FROM report_actions WHERE case_id IN (${cases})`, values);
  await target.client.query(`DELETE FROM report_case_evidence WHERE case_id IN (${cases})`, values);
  await target.client.query(`DELETE FROM evidence_snapshots WHERE target_id IN (${targets})`, values);
  await target.client.query(`DELETE FROM report_cases WHERE id IN (${cases})`, values);
  await target.client.query(`DELETE FROM report_targets WHERE id IN (${targets})`, values);
  await target.client.query(`DELETE FROM notifications WHERE qa_response_id IN (${responses})`, values);
  await target.client.query(`DELETE FROM qa_responses WHERE id IN (${responses})`, values);
  await target.client.query(`DELETE FROM qa_questions WHERE id IN (${questions})`, values);
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

type View = {
  id: string; publicationState: string; content: Record<string, unknown> | null;
  author: { userId: string; displayName: string } | null; version: number | null; capabilities: Record<string, boolean>;
};
type Body = {
  data?: { items?: View[]; resource?: { type: string; id: string }; version?: number; state?: string } & Partial<View>;
  error?: { code: string; fields?: { path: string; code: string }[] };
  meta: { replayed?: boolean };
};

async function result(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function mutationRequest(viewer: string, path: string, body: object, requestKey: string) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      Cookie: await cookieFor(viewer), Origin: origin, "Content-Type": "application/json", "Idempotency-Key": requestKey,
    },
    body: JSON.stringify(body),
  });
}

async function deleteQuestion(viewer: string, questionId: string, body: object, requestKey = randomUUID()) {
  const request = await mutationRequest(viewer, `/api/v1/questions/${questionId}/deletion`, body, requestKey);
  return result(await questionDeletionRoute.POST(request, { params: Promise.resolve({ questionId }) }));
}

async function deleteResponse(viewer: string, responseId: string, body: object, requestKey = randomUUID()) {
  const request = await mutationRequest(viewer, `/api/v1/responses/${responseId}/deletion`, body, requestKey);
  return result(await responseDeletionRoute.POST(request, { params: Promise.resolve({ responseId }) }));
}

async function createResponse(viewer: string, questionId: string, body: object) {
  const request = await mutationRequest(viewer, `/api/v1/questions/${questionId}/responses`, body, randomUUID());
  return result(await responsesRoute.POST(request, { params: Promise.resolve({ questionId }) }));
}

async function getQuestion(viewer: string, questionId: string) {
  return result(await questionRoute.GET(
    new Request(`${origin}/api/v1/questions/${questionId}`, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ questionId }) },
  ));
}

async function getResponse(viewer: string, responseId: string) {
  return result(await responseRoute.GET(
    new Request(`${origin}/api/v1/responses/${responseId}`, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ responseId }) },
  ));
}

async function listResponses(viewer: string, questionId: string) {
  return result(await responsesRoute.GET(
    new Request(`${origin}/api/v1/questions/${questionId}/responses`, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ questionId }) },
  ));
}

async function addQuestion(state: { author?: string; hidden?: boolean; deleted?: boolean } = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, forced_hidden_at, deleted_at)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = 'learning'), '削除する題名', $2, '質問時の表示名',
      CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END)
    RETURNING id
  `, [id(state.author ?? "poc_s001"), `秘密の質問本文 ${marker}`, state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

async function addResponse(questionId: string, state: {
  author?: string; parent?: string; kind?: string; hidden?: boolean; deleted?: boolean; body?: string;
} = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label,
      forced_hidden_at, deleted_at)
    VALUES ($1, $2, $3, $4, $5, '回答時の表示名', CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END) RETURNING id
  `, [questionId, id(state.author ?? "poc_a001"), state.kind ?? (state.parent ? "reply" : "answer"), state.parent ?? null,
    state.body ?? "残る本文", state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

async function questionRow(questionId: string) {
  const { rows: [row] } = await target.client.query<{ version: number; deleted: boolean; hidden: boolean }>(
    "SELECT version, deleted_at IS NOT NULL AS deleted, forced_hidden_at IS NOT NULL AS hidden FROM qa_questions WHERE id = $1",
    [questionId]);
  return row;
}

async function responseRows(questionId: string) {
  const { rows } = await target.client.query<{ id: string; version: number; deleted: boolean }>(
    "SELECT id, version, deleted_at IS NOT NULL AS deleted FROM qa_responses WHERE question_id = $1 ORDER BY created_at, id",
    [questionId]);
  return rows;
}

async function withUser<T>(username: string, change: string, restore: string, run: () => Promise<T>) {
  await target.client.query(`UPDATE community_users SET ${change} WHERE user_id = $1`, [id(username)]);
  try {
    return await run();
  } finally {
    await target.client.query(`UPDATE community_users SET ${restore} WHERE user_id = $1`, [id(username)]);
  }
}

/** 通報対象と案件を作る。通報対象は対象ごとに1行なので、既にあれば使う。 */
async function addCase(
  reported: { questionId: string } | { responseId: string },
  options: { status?: "unhandled" | "in_progress" | "closed"; assignee?: string | null } = {},
) {
  const [kind, column, targetRef] = "questionId" in reported
    ? ["question", "question_id", reported.questionId] as const
    : ["response", "response_id", reported.responseId] as const;
  const { rows: [{ id: targetId }] } = await target.client.query<{ id: string }>(`
    WITH found AS (SELECT id FROM report_targets WHERE ${column} = $2),
      inserted AS (
        INSERT INTO report_targets (kind, ${column}) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM found) RETURNING id
      )
    SELECT id FROM found UNION ALL SELECT id FROM inserted
  `, [kind, targetRef]);
  const status = options.status ?? "in_progress";
  const assignee = options.assignee === undefined ? "poc_school" : options.assignee;
  const { rows: [{ id: caseId }] } = await target.client.query<{ id: string }>(
    `INSERT INTO report_cases (target_id, status, assignee_id, handoff_pending, closed_at)
    VALUES ($1, $2, $3, false, CASE WHEN $2 = 'closed' THEN now() END) RETURNING id`,
    [targetId, status, assignee === null ? null : id(assignee)]);
  return caseId;
}

async function caseRow(caseId: string) {
  const { rows: [row] } = await target.client.query<{
    assignee_id: string | null; handoff_pending: boolean; status: string; version: number;
  }>("SELECT assignee_id, handoff_pending, status, version FROM report_cases WHERE id = $1", [caseId]);
  return row;
}

async function actionsOf(caseId: string) {
  const { rows } = await target.client.query<{ action_type: string; actor_id: string | null; system_action: boolean; after_state: unknown }>(
    "SELECT action_type, actor_id, system_action, after_state FROM report_actions WHERE case_id = $1", [caseId]);
  return rows;
}

async function evidenceOf(caseId: string) {
  const { rows } = await target.client.query<{ source_revision: number; snapshot: Record<string, unknown> }>(
    `SELECT e.source_revision, e.snapshot FROM report_case_evidence ce JOIN evidence_snapshots e ON e.id = ce.evidence_id
    WHERE ce.case_id = $1 ORDER BY e.captured_at, e.id`, [caseId]);
  return rows;
}

const confirm = (expectedVersion = 1) => ({ expectedVersion, confirmed: true });
const withheld = { content: null, author: null, version: null, capabilities: noCapabilities };

describe("API-QA-06 質問の本人削除（AC-09・AC-10）", () => {
  it("AC-09 本人が削除すると質問だけを論理削除し、回答・コメント・返信は残存スレッドとして表示・返信できる", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId);
    const comment = await addResponse(questionId, { kind: "comment", parent: answer, author: "poc_s002" });
    const questionComment = await addResponse(questionId, { kind: "comment", author: "poc_s002" });
    const reply = await addResponse(questionId, { parent: comment });

    const deleted = await deleteQuestion("poc_s001", questionId, confirm());
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toMatchObject({ resource: { type: "question", id: questionId }, version: 2, state: "deleted" });
    expect(await questionRow(questionId)).toMatchObject({ version: 2, deleted: true });
    expect((await responseRows(questionId)).map(({ deleted }) => deleted)).toEqual([false, false, false, false]);

    // AC-10 削除済みの本文・著者・版は、本人にも他人にも返さない。
    for (const viewer of ["poc_s001", "poc_a001", "poc_school"]) {
      const view = await getQuestion(viewer, questionId);
      expect(view.status).toBe(200);
      expect(view.body.data).toMatchObject({ id: questionId, publicationState: "deleted", ...withheld, resolution: null });
      expect(view.text).not.toMatch(/削除する題名|秘密の質問本文|質問時の表示名/);
    }

    const thread = await listResponses("poc_a001", questionId);
    expect(thread.status).toBe(200);
    expect(thread.body.data!.items!.map(({ id, publicationState }) => [id, publicationState])).toEqual([
      [answer, "public"], [comment, "public"], [questionComment, "public"], [reply, "public"],
    ]);
    expect(thread.text).not.toMatch(/削除する題名|秘密の質問本文/);

    // 残存する投稿へは返信でき、削除済みの質問への回答・直接のコメントは 409。
    expect((await createResponse("poc_a001", questionId, {
      kind: "reply", parentResponseId: reply, bodyMarkdown: "残存スレッドへの返信",
    })).status).toBe(201);
    for (const body of [{ kind: "answer" }, { kind: "comment" }]) {
      const rejected = await createResponse("poc_a001", questionId, { ...body, bodyMarkdown: "削除済みの質問へ" });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error?.code).toBe("STATE_CONFLICT");
    }
  });

  it("本人には canDelete を返し、他人・管理者には返さない。削除後はだれにも返さない", async () => {
    const questionId = await addQuestion();
    expect((await getQuestion("poc_s001", questionId)).body.data?.capabilities).toMatchObject({ canDelete: true, canEdit: true });
    for (const viewer of ["poc_a001", "poc_school", "poc_staff_mgr"]) {
      expect((await getQuestion(viewer, questionId)).body.data?.capabilities).toMatchObject({ canDelete: false, canEdit: false });
    }
    const hiddenProfile = await addQuestion({ author: "poc_hidden" });
    expect((await getQuestion("poc_hidden", hiddenProfile)).body.data?.capabilities)
      .toMatchObject({ canDelete: true, canEdit: false, canRespond: false });
  });

  it("他人・管理者・存在しない質問・削除済みの質問は404、確認なし・形式の誤りは422、古い版は409。いずれも変更しない", async () => {
    const questionId = await addQuestion();
    for (const viewer of ["poc_a001", "poc_school", "poc_staff_mgr"]) {
      const { status, text } = await deleteQuestion(viewer, questionId, confirm());
      expect(status).toBe(404);
      expect(text).not.toMatch(/削除する題名|秘密の質問本文/);
    }
    expect((await deleteQuestion("poc_s001", randomUUID(), confirm())).status).toBe(404);
    const alreadyDeleted = await addQuestion({ deleted: true });
    expect((await deleteQuestion("poc_s001", alreadyDeleted, confirm())).status).toBe(404);

    for (const body of [{ expectedVersion: 1 }, { expectedVersion: 1, confirmed: false }, { expectedVersion: 0, confirmed: true },
      { expectedVersion: 1, confirmed: true, title: "余分な項目" }]) {
      const { status, body: response } = await deleteQuestion("poc_s001", questionId, body);
      expect(status, JSON.stringify(body)).toBe(422);
      expect(response.error?.code).toBe("VALIDATION_FAILED");
    }
    const stale = await deleteQuestion("poc_s001", questionId, confirm(2));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");
    expect(await questionRow(questionId)).toMatchObject({ version: 1, deleted: false });
  });

  it("プロフィール非表示中・強制非表示中の本人も削除できる。停止中は削除できない", async () => {
    const hiddenProfile = await addQuestion({ author: "poc_hidden" });
    expect((await deleteQuestion("poc_hidden", hiddenProfile, confirm())).status).toBe(200);
    expect(await questionRow(hiddenProfile)).toMatchObject({ deleted: true });

    const forcedHidden = await addQuestion({ hidden: true });
    const deleted = await deleteQuestion("poc_s001", forcedHidden, confirm());
    expect(deleted.status).toBe(200);
    expect(deleted.body.data?.state).toBe("deleted");
    expect(await questionRow(forcedHidden)).toMatchObject({ deleted: true, hidden: true });

    const suspended = await addQuestion();
    await withUser("poc_s001", "account_status = 'suspended'", "account_status = 'active'", async () => {
      expect((await deleteQuestion("poc_s001", suspended, confirm())).status).toBe(403);
    });
    expect(await questionRow(suspended)).toMatchObject({ deleted: false });
  });

  it("同じ再送キーの再送は削除をやり直さず最初の結果を返す。別の内容での再利用は409", async () => {
    const questionId = await addQuestion();
    const key = randomUUID();
    const first = await deleteQuestion("poc_s001", questionId, confirm(), key);
    expect(first.status).toBe(200);
    const replay = await deleteQuestion("poc_s001", questionId, confirm(), key);
    expect(replay.status).toBe(200);
    expect(replay.body.meta.replayed).toBe(true);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await questionRow(questionId)).toMatchObject({ version: 2, deleted: true });

    const reused = await deleteQuestion("poc_s001", questionId, confirm(2), key);
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("API-QA-11 回答・コメント・返信の本人削除（AC-09・AC-10）", () => {
  it("AC-09 本人が削除すると対象だけを論理削除し、子のコメント・返信は残存スレッドとして表示・返信できる", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId, { body: "削除する回答の本文" });
    const comment = await addResponse(questionId, { kind: "comment", parent: answer, author: "poc_s002" });
    const reply = await addResponse(questionId, { parent: comment, author: "poc_s001" });

    const deleted = await deleteResponse("poc_a001", answer, confirm());
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toMatchObject({ resource: { type: "response", id: answer }, version: 2, state: "deleted" });
    expect((await responseRows(questionId)).map(({ id, deleted }) => [id, deleted])).toEqual([
      [answer, true], [comment, false], [reply, false],
    ]);
    expect(await questionRow(questionId)).toMatchObject({ version: 1, deleted: false });

    // AC-10 削除した投稿は、本人を含めて状態だけを返す。子は親子関係を保ったまま本文を返す。
    for (const viewer of ["poc_a001", "poc_s001", "poc_school"]) {
      const one = await getResponse(viewer, answer);
      expect(one.body.data).toMatchObject({ id: answer, publicationState: "deleted", ...withheld });
      expect(one.text).not.toMatch(/削除する回答の本文|回答時の表示名/);
    }
    const thread = await listResponses("poc_s001", questionId);
    expect(thread.body.data!.items!.map(({ id, publicationState, content }) => [id, publicationState, content !== null]))
      .toEqual([[answer, "deleted", false], [comment, "public", true], [reply, "public", true]]);
    expect(thread.text).not.toContain("削除する回答の本文");

    // 削除した投稿への直接の返信は 409、残存する子への返信は受け付ける。
    const toDeleted = await createResponse("poc_s001", questionId, {
      kind: "comment", parentResponseId: answer, bodyMarkdown: "削除済みの回答へ",
    });
    expect(toDeleted.status).toBe(409);
    expect(toDeleted.body.error?.code).toBe("STATE_CONFLICT");
    expect((await createResponse("poc_s001", questionId, {
      kind: "reply", parentResponseId: comment, bodyMarkdown: "残存するコメントへの返信",
    })).status).toBe(201);

    // 子の返信も、親と同じ条件で本人が削除できる。
    expect((await deleteResponse("poc_s001", reply, confirm())).status).toBe(200);
    expect((await responseRows(questionId)).find(({ id }) => id === comment)).toMatchObject({ deleted: false });
  });

  it("削除済みの質問に残る回答等も、本人が削除できる", async () => {
    const questionId = await addQuestion({ deleted: true });
    const answer = await addResponse(questionId);
    expect((await deleteResponse("poc_a001", answer, confirm())).status).toBe(200);
  });

  it("本人には canDelete を返し、他人・管理者には返さない", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId);
    expect((await getResponse("poc_a001", answer)).body.data?.capabilities).toMatchObject({ canDelete: true });
    for (const viewer of ["poc_s001", "poc_school", "poc_staff_mgr"]) {
      expect((await getResponse(viewer, answer)).body.data?.capabilities).toMatchObject({ canDelete: false });
    }
    const hiddenProfile = await addResponse(questionId, { author: "poc_hidden" });
    expect((await getResponse("poc_hidden", hiddenProfile)).body.data?.capabilities)
      .toMatchObject({ canDelete: true, canEdit: false, canRespond: false });
  });

  it("他人・管理者・存在しない投稿・削除済みの投稿は404、確認なしは422、古い版は409。プロフィール非表示中・強制非表示中の本人は削除できる", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId);
    for (const viewer of ["poc_s001", "poc_school", "poc_staff_mgr"]) {
      expect((await deleteResponse(viewer, answer, confirm())).status).toBe(404);
    }
    expect((await deleteResponse("poc_a001", randomUUID(), confirm())).status).toBe(404);
    expect((await deleteResponse("poc_a001", await addResponse(questionId, { deleted: true }), confirm())).status).toBe(404);
    expect((await deleteResponse("poc_a001", answer, { expectedVersion: 1 })).status).toBe(422);
    expect((await deleteResponse("poc_a001", answer, confirm(3))).status).toBe(409);
    expect((await responseRows(questionId)).find(({ id }) => id === answer)).toMatchObject({ version: 1, deleted: false });

    expect((await deleteResponse("poc_hidden", await addResponse(questionId, { author: "poc_hidden" }), confirm())).status).toBe(200);
    expect((await deleteResponse("poc_a001", await addResponse(questionId, { hidden: true }), confirm())).status).toBe(200);
  });

  it("同じ再送キーの再送は削除をやり直さず最初の結果を返す", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId);
    const key = randomUUID();
    const first = await deleteResponse("poc_a001", answer, confirm(), key);
    const replay = await deleteResponse("poc_a001", answer, confirm(), key);
    expect(replay.status).toBe(200);
    expect(replay.body.meta.replayed).toBe(true);
    expect(replay.body.data).toEqual(first.body.data);
    expect((await responseRows(questionId))[0]).toMatchObject({ version: 2, deleted: true });
  });
});

describe("削除前の通報証拠の保全と案件の引継ぎ（AC-10、#47 ③④）", () => {
  it("通報された公開中の質問は削除の前の内容を証拠に残し、アプリ管理者が担当する未終了案件だけを引継ぎ待ちにする", async () => {
    // 未終了の案件は対象ごとに1件のため、学校管理者が担当する案件は別の質問に作る。
    const questionId = await addQuestion();
    const closedCase = await addCase({ questionId }, { assignee: "poc_staff_mgr", status: "closed" });
    const appManagerCase = await addCase({ questionId }, { assignee: "poc_staff_mgr" });
    const schoolQuestion = await addQuestion();
    const schoolCase = await addCase({ questionId: schoolQuestion }, { assignee: "poc_school", status: "unhandled" });

    expect((await deleteQuestion("poc_s001", questionId, confirm())).status).toBe(200);
    expect((await deleteQuestion("poc_s001", schoolQuestion, confirm())).status).toBe(200);

    const snapshot = { source_revision: 1, snapshot: { title: "削除する題名", bodyMarkdown: `秘密の質問本文 ${marker}`, authorLabel: "質問時の表示名" } };
    expect(await evidenceOf(appManagerCase)).toEqual([snapshot]);
    expect(await evidenceOf(schoolCase)).toEqual([snapshot]);
    expect(await evidenceOf(closedCase)).toEqual([]);

    expect(await caseRow(appManagerCase)).toMatchObject({ assignee_id: null, handoff_pending: true, status: "in_progress", version: 2 });
    expect(await actionsOf(appManagerCase)).toEqual([{
      action_type: "handoff_started", actor_id: null, system_action: true,
      after_state: { assigneeId: null, handoffPending: true, trigger: "target_deleted" },
    }]);
    expect(await caseRow(schoolCase)).toMatchObject({ assignee_id: id("poc_school"), handoff_pending: false, version: 1 });
    expect(await caseRow(closedCase)).toMatchObject({ assignee_id: id("poc_staff_mgr"), handoff_pending: false, version: 1 });
    expect(await actionsOf(schoolCase)).toEqual([]);
  });

  it("通報された公開中の回答等も、削除の前の本文を証拠に残して引継ぎ待ちにする。子の投稿の案件は変えない", async () => {
    const questionId = await addQuestion();
    const answer = await addResponse(questionId, { body: "通報された回答" });
    const comment = await addResponse(questionId, { kind: "comment", parent: answer, author: "poc_s002" });
    const answerCase = await addCase({ responseId: answer }, { assignee: "poc_staff_mgr" });
    const childCase = await addCase({ responseId: comment }, { assignee: "poc_staff_mgr" });

    expect((await deleteResponse("poc_a001", answer, confirm())).status).toBe(200);
    expect(await evidenceOf(answerCase)).toEqual([{
      source_revision: 1,
      snapshot: { bodyMarkdown: "通報された回答", authorLabel: "回答時の表示名", kind: "answer", questionId, parentResponseId: null },
    }]);
    expect(await caseRow(answerCase)).toMatchObject({ assignee_id: null, handoff_pending: true });
    expect(await evidenceOf(childCase)).toEqual([]);
    expect(await caseRow(childCase)).toMatchObject({ assignee_id: id("poc_staff_mgr"), handoff_pending: false, version: 1 });
  });

  it("強制非表示中の投稿では証拠を作らずに引継ぎだけを行い、削除が失敗した場合はどちらも残さない", async () => {
    const questionId = await addQuestion({ hidden: true });
    const hiddenCase = await addCase({ questionId }, { assignee: "poc_staff_mgr" });
    expect((await deleteQuestion("poc_s001", questionId, confirm())).status).toBe(200);
    expect(await evidenceOf(hiddenCase)).toEqual([]);
    expect(await caseRow(hiddenCase)).toMatchObject({ assignee_id: null, handoff_pending: true });

    const publicQuestion = await addQuestion();
    const answer = await addResponse(publicQuestion);
    const answerCase = await addCase({ responseId: answer }, { assignee: "poc_staff_mgr" });
    expect((await deleteResponse("poc_a001", answer, confirm(5))).status).toBe(409);
    expect((await deleteResponse("poc_s001", answer, confirm())).status).toBe(404);
    expect(await evidenceOf(answerCase)).toEqual([]);
    expect(await caseRow(answerCase)).toMatchObject({ assignee_id: id("poc_staff_mgr"), handoff_pending: false, version: 1 });
    expect(await actionsOf(answerCase)).toEqual([]);
  });

  it("再送では証拠・引継ぎの履歴を重複して作らない", async () => {
    const questionId = await addQuestion();
    const caseId = await addCase({ questionId }, { assignee: "poc_staff_mgr" });
    const key = randomUUID();
    expect((await deleteQuestion("poc_s001", questionId, confirm(), key)).status).toBe(200);
    expect((await deleteQuestion("poc_s001", questionId, confirm(), key)).body.meta.replayed).toBe(true);
    expect(await evidenceOf(caseId)).toHaveLength(1);
    expect(await actionsOf(caseId)).toHaveLength(1);
  });
});
