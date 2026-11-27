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
 * 回答・コメント・返信の一覧・作成・取得・編集と通知（#9 ③④、API-QA-07〜10）。実際の Route Handler を実セッションで呼ぶ。
 * AC-05：取得できる回答・コメント・返信を、親子関係と投稿の種類とともに返す。
 * AC-06：削除済み・非表示の本文・著者・版番号を権限外の利用者へ返さない（回答等の部分）。
 * AC-07：有効な質問へ回答・コメント・返信を作成でき、親IDと投稿の種類の組合せを検証する。
 * AC-08：本人だけが自分の未削除の投稿を編集でき、プロフィール非表示中は新規投稿・編集を拒否する。
 * 通知（#17 AC-01・AC-02 の Q&A 部分）：宛先・件数・種類、再送で重複しないこと、失敗時に保存しないこと、本文を保存しないこと。
 * 通報証拠（DB・ER設計書 §5、#47 ③）：通報された公開中の質問・回答等は、編集の前の内容を未終了案件の証拠に残す。
 */

const origin = "https://school.example";
/** このテストが追加する質問の本文に付ける文字列。seed の質問と区別する。 */
const marker = "回答の検証用データ";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let responsesRoute: typeof import("../../src/app/api/v1/questions/[questionId]/responses/route");
let responseRoute: typeof import("../../src/app/api/v1/responses/[responseId]/route");
let questionRoute: typeof import("../../src/app/api/v1/questions/[questionId]/route");
let ipCounter = 0;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-responses-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user" WHERE username IS NOT NULL');
  for (const { id, username } of rows) ids.set(username, id);
  responsesRoute = await import("../../src/app/api/v1/questions/[questionId]/responses/route");
  responseRoute = await import("../../src/app/api/v1/responses/[responseId]/route");
  questionRoute = await import("../../src/app/api/v1/questions/[questionId]/route");
});

afterEach(async () => {
  const ours = "SELECT r.id FROM qa_responses r JOIN qa_questions q ON q.id = r.question_id WHERE q.body_markdown LIKE $1";
  const targets = `SELECT t.id FROM report_targets t WHERE t.response_id IN (${ours})
    OR t.question_id IN (SELECT id FROM qa_questions WHERE body_markdown LIKE $1)`;
  const cases = `SELECT id FROM report_cases WHERE target_id IN (${targets})`;
  await target.client.query(`DELETE FROM report_case_evidence WHERE case_id IN (${cases})`, [`%${marker}%`]);
  await target.client.query(`DELETE FROM evidence_snapshots WHERE target_id IN (${targets})`, [`%${marker}%`]);
  await target.client.query(`DELETE FROM report_cases WHERE id IN (${cases})`, [`%${marker}%`]);
  await target.client.query(`DELETE FROM report_targets WHERE id IN (${targets})`, [`%${marker}%`]);
  await target.client.query(`DELETE FROM notifications WHERE qa_response_id IN (${ours})`, [`%${marker}%`]);
  await target.client.query(`DELETE FROM qa_responses WHERE id IN (${ours})`, [`%${marker}%`]);
  await target.client.query("DELETE FROM qa_questions WHERE body_markdown LIKE $1", [`%${marker}%`]);
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
  id: string; questionId: string; parentResponseId: string | null; kind: string; publicationState: string;
  content: { bodyMarkdown: string } | null; author: { userId: string; displayName: string } | null;
  version: number | null; createdAt: string | null; updatedAt: string | null; capabilities: Record<string, boolean>;
};
type Body = {
  data?: { items?: View[]; resource?: { type: string; id: string }; version?: number; state?: string } & Partial<View>;
  error?: { code: string; fields?: { path: string; code: string; message: string }[] };
  meta: { replayed?: boolean; page?: { totalCount: number; hasMore: boolean; nextCursor: string | null; limit: number } };
};

async function result(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function list(viewer: string, questionId: string, query: Record<string, string> = {}) {
  const url = `${origin}/api/v1/questions/${questionId}/responses?${new URLSearchParams(query)}`;
  return result(await responsesRoute.GET(new Request(url, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ questionId }) }));
}

async function getOne(viewer: string, responseId: string) {
  return result(await responseRoute.GET(
    new Request(`${origin}/api/v1/responses/${responseId}`, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ responseId }) },
  ));
}

async function mutationRequest(viewer: string, method: "POST" | "PATCH", path: string, body: object, requestKey: string) {
  return new Request(origin + path, {
    method,
    headers: {
      Cookie: await cookieFor(viewer), Origin: origin, "Content-Type": "application/json", "Idempotency-Key": requestKey,
    },
    body: JSON.stringify(body),
  });
}

async function create(viewer: string, questionId: string, body: object, requestKey = randomUUID()) {
  const request = await mutationRequest(viewer, "POST", `/api/v1/questions/${questionId}/responses`, body, requestKey);
  return result(await responsesRoute.POST(request, { params: Promise.resolve({ questionId }) }));
}

async function edit(viewer: string, responseId: string, body: object, requestKey = randomUUID()) {
  const request = await mutationRequest(viewer, "PATCH", `/api/v1/responses/${responseId}`, body, requestKey);
  return result(await responseRoute.PATCH(request, { params: Promise.resolve({ responseId }) }));
}

/** 作成し、作成した投稿のIDを返す。 */
async function created(viewer: string, questionId: string, body: object): Promise<string> {
  const { status, body: response } = await create(viewer, questionId, body);
  expect(status, JSON.stringify(response)).toBe(201);
  return response.data!.resource!.id;
}

async function addQuestion(state: { author?: string; hidden?: boolean; deleted?: boolean } = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, forced_hidden_at, deleted_at)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = 'learning'), '題名', $2, 'はる',
      CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END)
    RETURNING id
  `, [id(state.author ?? "poc_s001"), `本文 ${marker}`, state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

async function addResponse(questionId: string, state: {
  author?: string; parent?: string; kind?: string; hidden?: boolean; deleted?: boolean; createdAt?: string;
} = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label, created_at,
      forced_hidden_at, deleted_at)
    VALUES ($1, $2, $3, $4, '秘密の本文', '投稿時の表示名', coalesce($5::timestamptz, now()),
      CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END) RETURNING id
  `, [questionId, id(state.author ?? "poc_a001"), state.kind ?? (state.parent ? "reply" : "answer"), state.parent ?? null,
    state.createdAt ?? null, state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

async function notificationsFor(responseId: string) {
  const { rows } = await target.client.query<{ recipient_id: string; kind: string; public_message: string; read_at: Date | null }>(
    "SELECT recipient_id, kind, public_message, read_at FROM notifications WHERE qa_response_id = $1 ORDER BY recipient_id",
    [responseId],
  );
  return rows;
}

async function responseCount(questionId: string) {
  const { rows } = await target.client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM qa_responses WHERE question_id = $1", [questionId]);
  return rows[0].total;
}

async function withUser<T>(username: string, change: string, restore: string, run: () => Promise<T>) {
  await target.client.query(`UPDATE community_users SET ${change} WHERE user_id = $1`, [id(username)]);
  try {
    return await run();
  } finally {
    await target.client.query(`UPDATE community_users SET ${restore} WHERE user_id = $1`, [id(username)]);
  }
}

/** 通報対象と案件を作る。通報対象は対象ごとに1行なので、既にあれば使う。未終了の案件は学校管理者の担当にする。 */
async function addCase(reported: { questionId: string } | { responseId: string }, status: "in_progress" | "closed" = "in_progress") {
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
  const { rows: [{ id: caseId }] } = await target.client.query<{ id: string }>(
    `INSERT INTO report_cases (target_id, status, assignee_id, handoff_pending, closed_at)
    VALUES ($1, $2, $3, false, CASE WHEN $2 = 'closed' THEN now() END) RETURNING id`,
    [targetId, status, id("poc_school")]);
  return caseId;
}

async function evidenceOf(caseId: string) {
  const { rows } = await target.client.query<{ source_revision: number; snapshot: Record<string, unknown> }>(
    `SELECT e.source_revision, e.snapshot FROM report_case_evidence ce JOIN evidence_snapshots e ON e.id = ce.evidence_id
    WHERE ce.case_id = $1 ORDER BY e.captured_at, e.id`, [caseId]);
  return rows;
}

async function editQuestion(viewer: string, questionId: string, body: object) {
  const request = await mutationRequest(viewer, "PATCH", `/api/v1/questions/${questionId}`, body, randomUUID());
  return result(await questionRoute.PATCH(request, { params: Promise.resolve({ questionId }) }));
}

const withheld = { content: null, author: null, version: null, createdAt: null, updatedAt: null, capabilities: noCapabilities };

describe("API-QA-08 回答・コメント・返信の作成（AC-07）と通知", () => {
  it("AC-07 回答・コメント・返信を作成し、質問者・直接の親の投稿者へ1件ずつ通知する。通知に本文を保存しない", async () => {
    const questionId = await addQuestion();
    const answer = await create("poc_a001", questionId, { kind: "answer", bodyMarkdown: "回答の **本文**\r\n2行目" });
    expect(answer.status).toBe(201);
    expect(answer.body.data).toMatchObject({ resource: { type: "response", id: expect.any(String) }, version: 1, state: "public" });
    const answerId = answer.body.data!.resource!.id;
    const commentId = await created("poc_s002", questionId, { kind: "comment", parentResponseId: answerId, bodyMarkdown: "コメントの本文" });
    const replyId = await created("poc_s001", questionId, { kind: "reply", parentResponseId: commentId, bodyMarkdown: "返信の本文" });
    const questionCommentId = await created("poc_staff", questionId, { kind: "comment", parentResponseId: null, bodyMarkdown: "質問へのコメント" });

    expect(await notificationsFor(answerId)).toEqual([
      { recipient_id: id("poc_s001"), kind: "qa_answer_created", public_message: "質問に回答が付きました。", read_at: null },
    ]);
    expect(await notificationsFor(commentId)).toEqual([
      { recipient_id: id("poc_a001"), kind: "qa_comment_created", public_message: "投稿にコメントが付きました。", read_at: null },
    ]);
    expect(await notificationsFor(replyId)).toEqual([
      { recipient_id: id("poc_s002"), kind: "qa_reply_created", public_message: "投稿に返信が付きました。", read_at: null },
    ]);
    expect(await notificationsFor(questionCommentId)).toEqual([
      expect.objectContaining({ recipient_id: id("poc_s001"), kind: "qa_comment_created" }),
    ]);

    const { body } = await list("poc_s002", questionId);
    expect(body.data!.items).toEqual([
      {
        id: answerId, questionId, parentResponseId: null, kind: "answer", publicationState: "public",
        content: { bodyMarkdown: "回答の **本文**\n2行目" }, author: { userId: id("poc_a001"), displayName: "あおい" },
        version: 1, createdAt: expect.stringMatching(/Z$/), updatedAt: expect.stringMatching(/Z$/),
        capabilities: { ...noCapabilities, canRespond: true },
      },
      expect.objectContaining({ id: commentId, parentResponseId: answerId, kind: "comment", author: { userId: id("poc_s002"), displayName: "みなと" } }),
      expect.objectContaining({ id: replyId, parentResponseId: commentId, kind: "reply" }),
      expect.objectContaining({ id: questionCommentId, parentResponseId: null, kind: "comment" }),
    ]);
    expect(body.data!.items![1].capabilities).toEqual({ ...noCapabilities, canRespond: true, canEdit: true, canDelete: true });
  });

  it("自分の質問・投稿への回答・返信では通知しない", async () => {
    const questionId = await addQuestion();
    const answerId = await created("poc_s001", questionId, { kind: "answer", bodyMarkdown: "自分で回答" });
    const replyId = await created("poc_s001", questionId, { kind: "reply", parentResponseId: answerId, bodyMarkdown: "自分へ返信" });
    expect(await notificationsFor(answerId)).toEqual([]);
    expect(await notificationsFor(replyId)).toEqual([]);
  });

  it("同じ再送キーの再送は最初の結果を返し、投稿・通知を重複して作らない。別の内容は409", async () => {
    const questionId = await addQuestion();
    const key = randomUUID();
    const body = { kind: "answer", bodyMarkdown: "一度だけ" };
    const first = await create("poc_a001", questionId, body, key);
    const again = await create("poc_a001", questionId, body, key);
    expect(again.status).toBe(201);
    expect(again.body.meta.replayed).toBe(true);
    expect(again.body.data).toEqual(first.body.data);
    expect(await responseCount(questionId)).toBe(1);
    expect(await notificationsFor(first.body.data!.resource!.id)).toHaveLength(1);
    expect((await create("poc_a001", questionId, { ...body, bodyMarkdown: "別の内容" }, key)).body.error?.code)
      .toBe("IDEMPOTENCY_KEY_REUSED");
    // 再送時も現在の権限を確認する。
    await withUser("poc_a001", "profile_state = 'hidden'", "profile_state = 'public'", async () => {
      const replay = await create("poc_a001", questionId, body, key);
      expect(replay.status).toBe(403);
      expect(replay.body.error?.code).toBe("PROFILE_WRITE_RESTRICTED");
    });
  });

  it("AC-07 投稿の種類と親IDの組合せ、本文の文字数・制限Markdownを検証する", async () => {
    const questionId = await addQuestion();
    const otherQuestion = await addQuestion();
    const answerId = await addResponse(questionId);
    const otherAnswer = await addResponse(otherQuestion);
    const invalid: [object, string, string][] = [
      [{ kind: "answer", parentResponseId: answerId, bodyMarkdown: "本文" }, "parentResponseId", "parent_not_allowed"],
      [{ kind: "reply", bodyMarkdown: "本文" }, "parentResponseId", "parent_required"],
      [{ kind: "reply", parentResponseId: null, bodyMarkdown: "本文" }, "parentResponseId", "parent_required"],
      [{ kind: "reply", parentResponseId: otherAnswer, bodyMarkdown: "本文" }, "parentResponseId", "parent_not_found"],
      [{ kind: "comment", parentResponseId: randomUUID(), bodyMarkdown: "本文" }, "parentResponseId", "parent_not_found"],
      [{ kind: "question", bodyMarkdown: "本文" }, "kind", "invalid_value"],
      [{ kind: "comment", bodyMarkdown: "あ".repeat(2_001) }, "bodyMarkdown", "too_big"],
      [{ kind: "answer", bodyMarkdown: "あ".repeat(10_001) }, "bodyMarkdown", "custom"],
      [{ kind: "answer", bodyMarkdown: "  \n " }, "bodyMarkdown", "custom"],
      [{ kind: "reply", parentResponseId: answerId, bodyMarkdown: "<b>HTML</b>" }, "bodyMarkdown", "markdown_html"],
      [{ kind: "answer", bodyMarkdown: "[x](javascript:alert(1))" }, "bodyMarkdown", "markdown_url"],
      [{ kind: "answer", bodyMarkdown: "本文", questionId: otherQuestion }, "", "unknown_field"],
    ];
    for (const [body, path, code] of invalid) {
      const response = await create("poc_s002", questionId, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(response.body.error?.fields, JSON.stringify(body).slice(0, 80)).toContainEqual(expect.objectContaining({ path, code }));
    }
    expect(await responseCount(questionId)).toBe(1);
    expect(await created("poc_s002", questionId, { kind: "comment", bodyMarkdown: "𠮷".repeat(2_000) })).toEqual(expect.any(String));
    expect(await created("poc_s002", questionId, { kind: "answer", bodyMarkdown: "あ".repeat(10_000) })).toEqual(expect.any(String));
  });

  it("削除済み・強制非表示の質問への回答・直接のコメントと、削除済み・非表示の投稿への返信を409にし、何も保存しない", async () => {
    for (const state of [{ deleted: true }, { hidden: true }]) {
      const questionId = await addQuestion(state);
      for (const body of [{ kind: "answer", bodyMarkdown: "本文" }, { kind: "comment", bodyMarkdown: "本文" }]) {
        const response = await create("poc_a001", questionId, body);
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe("STATE_CONFLICT");
      }
      // 質問が削除・非表示でも、残存する公開中の回答への返信は受け付ける（共通認可条件表 §2）。
      const residual = await addResponse(questionId, { author: "poc_s002" });
      const replyId = await created("poc_a001", questionId, { kind: "reply", parentResponseId: residual, bodyMarkdown: "残存回答への返信" });
      expect(await notificationsFor(replyId)).toEqual([expect.objectContaining({ recipient_id: id("poc_s002"), kind: "qa_reply_created" })]);
    }

    const questionId = await addQuestion();
    for (const state of [{ deleted: true }, { hidden: true }]) {
      const parent = await addResponse(questionId, state);
      const response = await create("poc_a001", questionId, { kind: "reply", parentResponseId: parent, bodyMarkdown: "本文" });
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("STATE_CONFLICT");
    }
    expect(await responseCount(questionId)).toBe(2);
    const { rows } = await target.client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM notifications n JOIN qa_responses r ON r.id = n.qa_response_id WHERE r.question_id = $1",
      [questionId]);
    expect(rows[0].total).toBe(0);
  });

  it("AC-08 プロフィール非表示中・停止中は投稿できず、存在しない質問は404", async () => {
    const questionId = await addQuestion();
    const hidden = await create("poc_hidden", questionId, { kind: "answer", bodyMarkdown: "本文" });
    expect(hidden.status).toBe(403);
    expect(hidden.body.error?.code).toBe("PROFILE_WRITE_RESTRICTED");
    const suspended = await withUser("poc_s002", "account_status = 'suspended'", "account_status = 'active'",
      () => create("poc_s002", questionId, { kind: "answer", bodyMarkdown: "本文" }));
    expect(suspended.status).toBe(403);
    expect(suspended.body.error?.code).toBe("ACCOUNT_SUSPENDED");
    expect(await responseCount(questionId)).toBe(0);
    expect((await create("poc_s002", randomUUID(), { kind: "answer", bodyMarkdown: "本文" })).status).toBe(404);
  });
});

describe("API-QA-10 回答・コメント・返信の編集（AC-08）", () => {
  it("本人だけが本文を編集でき、版番号を進める。古い版は409", async () => {
    const questionId = await addQuestion();
    const answerId = await created("poc_a001", questionId, { kind: "answer", bodyMarkdown: "編集前" });
    const saved = await edit("poc_a001", answerId, { expectedVersion: 1, bodyMarkdown: "編集後" });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ resource: { type: "response", id: answerId }, version: 2, state: "public" });
    expect((await getOne("poc_s002", answerId)).body.data).toMatchObject({
      content: { bodyMarkdown: "編集後" }, version: 2, kind: "answer", parentResponseId: null,
    });
    const stale = await edit("poc_a001", answerId, { expectedVersion: 1, bodyMarkdown: "古い版から" });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");
    // 編集では通知を作らない。
    expect(await notificationsFor(answerId)).toHaveLength(1);
  });

  it("他人・削除済み・存在しない投稿は404、プロフィール非表示中は403。版の不一致より先に権限を確認する", async () => {
    const questionId = await addQuestion();
    const answerId = await addResponse(questionId);
    const deletedId = await addResponse(questionId, { deleted: true });
    for (const [viewer, responseId] of [["poc_s002", answerId], ["poc_school", answerId], ["poc_a001", deletedId], ["poc_a001", randomUUID()]]) {
      const { status, text } = await edit(viewer, responseId, { expectedVersion: 99, bodyMarkdown: "書き換え" });
      expect(status, `${viewer} ${responseId}`).toBe(404);
      expect(text).not.toContain("秘密の本文");
    }
    const hiddenProfile = await addResponse(questionId, { author: "poc_hidden" });
    const restricted = await edit("poc_hidden", hiddenProfile, { expectedVersion: 1, bodyMarkdown: "書き換え" });
    expect(restricted.status).toBe(403);
    expect(restricted.body.error?.code).toBe("PROFILE_WRITE_RESTRICTED");
    const { rows } = await target.client.query<{ body_markdown: string }>(
      "SELECT body_markdown FROM qa_responses WHERE question_id = $1", [questionId]);
    expect(rows.every(({ body_markdown }) => body_markdown === "秘密の本文")).toBe(true);
  });

  it("投稿の種類・親・質問は変更できず、コメント・返信は2,000文字まで。強制非表示は編集で解除しない", async () => {
    const questionId = await addQuestion();
    const answerId = await addResponse(questionId);
    const commentId = await addResponse(questionId, { kind: "comment", parent: answerId });
    for (const extra of [{ kind: "answer" }, { parentResponseId: null }, { questionId }]) {
      const response = await edit("poc_a001", commentId, { expectedVersion: 1, bodyMarkdown: "本文", ...extra });
      expect(response.status).toBe(422);
      expect(response.body.error?.fields).toContainEqual(expect.objectContaining({ code: "unknown_field" }));
    }
    const tooLong = await edit("poc_a001", commentId, { expectedVersion: 1, bodyMarkdown: "あ".repeat(2_001) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error?.fields).toEqual([expect.objectContaining({ path: "bodyMarkdown", code: "too_big" })]);
    expect((await edit("poc_a001", answerId, { expectedVersion: 1, bodyMarkdown: "あ".repeat(2_001) })).status).toBe(200);

    const hiddenId = await addResponse(questionId, { hidden: true });
    const saved = await edit("poc_a001", hiddenId, { expectedVersion: 1, bodyMarkdown: "非表示中の編集" });
    expect(saved.body.data).toMatchObject({ version: 2, state: "hidden" });
    expect((await getOne("poc_s002", hiddenId)).body.data).toMatchObject({ publicationState: "hidden", content: null });
  });
});

describe("API-QA-07・09 回答・コメント・返信の取得（AC-05・AC-06）", () => {
  it("AC-06 削除済みの投稿は全員に、強制非表示の投稿は本人と管理できる管理者以外に、状態だけを返す", async () => {
    const questionId = await addQuestion();
    const deletedId = await addResponse(questionId, { deleted: true });
    const hiddenId = await addResponse(questionId, { hidden: true });
    const childId = await addResponse(questionId, { parent: deletedId, author: "poc_s002" });
    const managerHidden = await addResponse(questionId, { hidden: true, author: "poc_s_mgr" });

    const deletedView = { id: deletedId, questionId, parentResponseId: null, kind: "answer", publicationState: "deleted", ...withheld };
    for (const viewer of ["poc_a001", "poc_school", "poc_s002"]) {
      expect((await getOne(viewer, deletedId)).body.data).toEqual(deletedView);
    }
    for (const viewer of ["poc_s002", "poc_staff", "poc_hidden"]) {
      const { body, text } = await list(viewer, questionId);
      expect(body.data!.items!.map(({ id: itemId }) => itemId)).toEqual([deletedId, hiddenId, childId, managerHidden]);
      expect(body.data!.items![0]).toEqual(deletedView);
      expect(body.data!.items![1]).toEqual({ ...deletedView, id: hiddenId, publicationState: "hidden" });
      expect(body.data!.items![2]).toMatchObject({ parentResponseId: deletedId, content: { bodyMarkdown: "秘密の本文" } });
      expect(body.meta.page).toMatchObject({ totalCount: 4, hasMore: false });
      expect(text.split("秘密の本文")).toHaveLength(2);
      expect(text).not.toContain(id("poc_a001"));
    }
    // 返信先が削除済みでも、残存する子の投稿にはそれぞれの状態で返信できる。
    expect((await list("poc_s001", questionId)).body.data!.items![2].capabilities).toEqual({ ...noCapabilities, canRespond: true });
    // 本人と、管理できる管理者には内容を返す。返信はできない。
    for (const viewer of ["poc_a001", "poc_school", "poc_s_mgr"]) {
      expect((await getOne(viewer, hiddenId)).body.data, viewer).toMatchObject({
        publicationState: "hidden", content: { bodyMarkdown: "秘密の本文" }, version: 1,
        capabilities: { ...noCapabilities, canEdit: viewer === "poc_a001", canDelete: viewer === "poc_a001" },
      });
    }
    // アプリ管理者の投稿は、本人と学校管理者だけ。
    expect((await getOne("poc_a_mgr", managerHidden)).body.data).toMatchObject({ content: null });
    expect((await getOne("poc_school", managerHidden)).body.data).toMatchObject({ content: { bodyMarkdown: "秘密の本文" } });
  });

  it("AC-05 作成日時・IDの昇順で、同じ日時でもページ間の重複・欠落がない", async () => {
    const questionId = await addQuestion();
    const at = "2026-11-01T00:00:00.123456Z";
    const sameTime: string[] = [];
    for (let index = 0; index < 5; index++) sameTime.push(await addResponse(questionId, { createdAt: at }));
    const later = await addResponse(questionId, { createdAt: "2026-11-02T00:00:00Z" });
    const expected = [...sameTime.sort((a, b) => (a < b ? -1 : 1)), later];
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { body } = await list("poc_s002", questionId, { limit: "2", ...(cursor ? { cursor } : {}) });
      expect(body.meta.page?.totalCount).toBe(6);
      seen.push(...body.data!.items!.map(({ id: itemId }) => itemId));
      cursor = body.meta.page?.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expected);
  });

  it("ほかの質問・利用者のカーソル、存在しない質問・投稿、形式の誤りを拒否する", async () => {
    const questionId = await addQuestion();
    const otherQuestion = await addQuestion();
    for (let index = 0; index < 3; index++) await addResponse(questionId);
    const cursor = (await list("poc_s002", questionId, { limit: "1" })).body.meta.page!.nextCursor!;
    expect((await list("poc_s002", otherQuestion, { cursor })).body.error?.code).toBe("INVALID_CURSOR");
    expect((await list("poc_a001", questionId, { cursor })).body.error?.code).toBe("INVALID_CURSOR");
    expect((await list("poc_s002", questionId, { sort: "x" })).status).toBe(400);
    expect((await list("poc_s002", randomUUID())).status).toBe(404);
    expect((await getOne("poc_s002", randomUUID())).status).toBe(404);
    expect((await getOne("poc_s002", "x")).status).toBe(400);
  });

  it("停止中の利用者は一覧・取得を利用できない", async () => {
    const questionId = await addQuestion();
    const answerId = await addResponse(questionId);
    await withUser("poc_s002", "account_status = 'suspended'", "account_status = 'active'", async () => {
      for (const response of [await list("poc_s002", questionId), await getOne("poc_s002", answerId)]) {
        expect(response.status).toBe(403);
        expect(response.text).not.toContain("秘密の本文");
      }
    });
  });
});

describe("通報証拠：編集の前の内容を保全する（DB・ER設計書 §5、#47 ③）", () => {
  it("通報された公開中の回答等は、編集の前の本文を未終了案件の証拠に残す。同じ内容への編集では重複させない", async () => {
    const questionId = await addQuestion();
    const answerId = await created("poc_a001", questionId, { kind: "answer", bodyMarkdown: "通報された回答" });
    const caseId = await addCase({ responseId: answerId });
    const closedCase = await addCase({ responseId: answerId }, "closed");

    expect((await edit("poc_a001", answerId, { expectedVersion: 1, bodyMarkdown: "書き換えた回答" })).status).toBe(200);
    expect(await evidenceOf(caseId)).toEqual([{
      source_revision: 1,
      snapshot: { bodyMarkdown: "通報された回答", authorLabel: "あおい", kind: "answer", questionId, parentResponseId: null },
    }]);
    // 対応済みの案件には関連付けない。
    expect(await evidenceOf(closedCase)).toEqual([]);

    expect((await edit("poc_a001", answerId, { expectedVersion: 2, bodyMarkdown: "さらに書き換えた回答" })).status).toBe(200);
    expect((await evidenceOf(caseId)).map(({ snapshot }) => snapshot.bodyMarkdown)).toEqual(["通報された回答", "書き換えた回答"]);
  });

  it("強制非表示中の回答等と、通報されていない回答等では証拠を作らない。編集が失敗した場合も残さない", async () => {
    const questionId = await addQuestion();
    const hiddenId = await addResponse(questionId, { hidden: true });
    const hiddenCase = await addCase({ responseId: hiddenId });
    expect((await edit("poc_a001", hiddenId, { expectedVersion: 1, bodyMarkdown: "非表示中の編集" })).status).toBe(200);
    expect(await evidenceOf(hiddenCase)).toEqual([]);

    const answerId = await addResponse(questionId);
    const reportedCase = await addCase({ responseId: answerId });
    expect((await edit("poc_a001", answerId, { expectedVersion: 9, bodyMarkdown: "古い版での編集" })).status).toBe(409);
    expect(await evidenceOf(reportedCase)).toEqual([]);

    const unreported = await addResponse(questionId);
    expect((await edit("poc_a001", unreported, { expectedVersion: 1, bodyMarkdown: "通報されていない" })).status).toBe(200);
    const { rows } = await target.client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM report_targets WHERE response_id = $1", [unreported]);
    expect(rows[0].total).toBe(0);
  });

  it("通報された公開中の質問は、編集の前の題名・本文を未終了案件の証拠に残す", async () => {
    const questionId = await addQuestion();
    const caseId = await addCase({ questionId });
    const saved = await editQuestion("poc_s001", questionId, { expectedVersion: 1, title: "書き換えた題名" });
    expect(saved.status).toBe(200);
    expect(await evidenceOf(caseId)).toEqual([{
      source_revision: 1, snapshot: { title: "題名", bodyMarkdown: `本文 ${marker}`, authorLabel: "はる" },
    }]);
    // 証拠に含めない項目（カテゴリー）だけの変更では、同じ内容の証拠を重複させない。
    expect((await editQuestion("poc_s001", questionId, { expectedVersion: 2, categoryCode: "chat" })).status).toBe(200);
    expect((await editQuestion("poc_s001", questionId, { expectedVersion: 3, categoryCode: "career" })).status).toBe(200);
    expect((await evidenceOf(caseId)).map(({ snapshot }) => snapshot.title)).toEqual(["題名", "書き換えた題名"]);
  });
});
