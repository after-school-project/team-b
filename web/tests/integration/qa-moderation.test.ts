import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { POST as questionVisibility } from "../../src/app/api/v1/admin/questions/[questionId]/visibility/route";
import { POST as responseVisibility } from "../../src/app/api/v1/admin/responses/[responseId]/visibility/route";
import { GET as getQuestion, PATCH as editQuestion } from "../../src/app/api/v1/questions/[questionId]/route";
import { GET as listResponses } from "../../src/app/api/v1/questions/[questionId]/responses/route";
import { GET as searchQuestions } from "../../src/app/api/v1/questions/route";
import { GET as getResponse, PATCH as editResponse } from "../../src/app/api/v1/responses/[responseId]/route";
import { endPool, isolatedDatabase } from "./isolated-database";

const origin = "https://school.example";
const author = "poc_s001";
const member = "poc_s002";
const manager = "poc_s_mgr";
const school = "poc_school";
const reason = "利用者に公開できない内容を含むため";
const secretBody = "強制非表示の検証専用本文";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString() });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-qa-moderation-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  const credentials: Record<string, string> = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { POST: signIn } = await import("../../src/app/api/auth/[...auth]/route");
  for (const [index, username] of [author, member, manager, school].entries()) {
    const { rows } = await target.client.query<{ id: string }>('SELECT id FROM "user" WHERE username = $1', [username]);
    ids.set(username, rows[0].id);
    const response = await signIn(new Request(origin + "/api/auth/sign-in/username", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${index + 1}` },
      body: JSON.stringify({ username, password: credentials[username] }),
    }));
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie()
      .find((value) => value.startsWith("__Secure-better-auth.session_token="))?.split(";", 1)[0];
    if (!cookie) throw new Error("テスト用セッションを発行できませんでした。");
    cookies.set(username, cookie);
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

type Post = { type: "question" | "response"; id: string };

function request(viewer: string, path: string, method = "GET", body?: object, key = randomUUID()) {
  const headers = new Headers({ Cookie: cookies.get(viewer)! });
  if (body === undefined) return new Request(origin + path, { headers });
  headers.set("Origin", origin);
  headers.set("Content-Type", "application/json");
  headers.set("Idempotency-Key", key);
  return new Request(origin + path, { method, headers, body: JSON.stringify(body) });
}

async function read(response: Response) {
  const text = await response.text();
  const body: {
    data?: unknown;
    error?: { code: string; fields?: { path: string; code: string }[] };
    meta?: { replayed?: boolean; page?: { totalCount: number } };
  } = JSON.parse(text);
  return { status: response.status, body, text };
}

async function change(viewer: string, post: Post, body: object, key = randomUUID()) {
  const input = request(viewer, `/api/v1/admin/${post.type}s/${post.id}/visibility`, "POST", body, key);
  return read(post.type === "question"
    ? await questionVisibility(input, { params: Promise.resolve({ questionId: post.id }) })
    : await responseVisibility(input, { params: Promise.resolve({ responseId: post.id }) }));
}

async function detail(viewer: string, post: Post) {
  const input = request(viewer, `/api/v1/${post.type}s/${post.id}`);
  return read(post.type === "question"
    ? await getQuestion(input, { params: Promise.resolve({ questionId: post.id }) })
    : await getResponse(input, { params: Promise.resolve({ responseId: post.id }) }));
}

async function edit(viewer: string, post: Post, bodyMarkdown: string, version: number) {
  const input = request(viewer, `/api/v1/${post.type}s/${post.id}`, "PATCH", { expectedVersion: version, bodyMarkdown });
  return read(post.type === "question"
    ? await editQuestion(input, { params: Promise.resolve({ questionId: post.id }) })
    : await editResponse(input, { params: Promise.resolve({ responseId: post.id }) }));
}

async function addQuestion(username = author, deleted = false): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, deleted_at)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = 'learning'), $2, $3, '検証用の投稿者',
      CASE WHEN $4 THEN now() END)
    RETURNING id
  `, [ids.get(username), `案件の検証 ${randomUUID()}`, secretBody, deleted]);
  return rows[0].id;
}

async function addResponse(questionId: string, username = author): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, author_label, kind, body_markdown)
    VALUES ($1, $2, '検証用の投稿者', 'comment', $3) RETURNING id
  `, [questionId, ids.get(username), secretBody]);
  return rows[0].id;
}

async function addCase(post: Post, state: { schoolOnly?: boolean; closed?: boolean; handoff?: boolean } = {}) {
  const { rows: [report] } = await target.client.query<{ id: string }>(`
    INSERT INTO report_targets (kind, question_id, response_id) VALUES ($1, $2, $3)
    ON CONFLICT (${post.type === "question" ? "question_id" : "response_id"})
    DO UPDATE SET kind = EXCLUDED.kind RETURNING id
  `, [post.type, post.type === "question" ? post.id : null, post.type === "response" ? post.id : null]);
  const { rows: [reportCase] } = await target.client.query<{ id: string }>(`
    INSERT INTO report_cases (target_id, assignee_id, school_only, handoff_pending, status, closed_at)
    VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'closed' THEN now() END) RETURNING id
  `, [report.id, state.handoff ? null : ids.get(school), Boolean(state.schoolOnly), Boolean(state.handoff),
    state.closed ? "closed" : "in_progress"]);
  return reportCase.id;
}

it.each(["question", "response"] as const)("AC-01・03・04 %s を非表示・復元し、本文と副作用を制御する", async (type) => {
  const questionId = await addQuestion();
  const post = { type, id: type === "question" ? questionId : await addResponse(questionId) };
  const hide = { expectedVersion: 1, visibility: "hidden", reason };
  for (const invalidReason of [null, "　 ", "あ".repeat(1001)]) {
    const invalid = await change(manager, post, { ...hide, reason: invalidReason });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.fields).toEqual([expect.objectContaining({ path: "reason" })]);
  }
  const denied = await change(member, post, hide);
  expect(denied.status).toBe(403);
  expect(denied.text).not.toContain(secretBody);

  const key = randomUUID();
  const attempts = await Promise.all([change(manager, post, hide, key), change(manager, post, hide, key)]);
  const hidden = attempts.find((attempt) => !attempt.body.meta?.replayed)!;
  const replay = attempts.find((attempt) => attempt.body.meta?.replayed)!;
  expect(hidden.status).toBe(200);
  expect(hidden.body.data).toMatchObject({ resource: post, version: 2, state: "hidden" });
  expect(replay.status).toBe(200);
  expect(replay.body.data).toEqual(hidden.body.data);
  expect((await change(school, post, hide)).body.error?.code).toBe("VERSION_CONFLICT");
  expect((await change(school, post, { ...hide, expectedVersion: 2 })).body.error?.code).toBe("STATE_CONFLICT");

  const withheld = await detail(member, post);
  expect(withheld.text).not.toContain(secretBody);
  expect(withheld.body.data).toMatchObject({ publicationState: "hidden", content: null, author: null, version: null });
  expect((await detail(author, post)).body.data).toMatchObject({ content: { bodyMarkdown: secretBody }, capabilities: { canRestore: false } });
  expect((await detail(manager, post)).body.data).toMatchObject({ content: { bodyMarkdown: secretBody }, capabilities: { canRestore: true } });
  if (type === "question") {
    const response = await searchQuestions(request(member, `/api/v1/questions?q=${encodeURIComponent(secretBody)}`), {});
    expect((await read(response)).body.meta?.page?.totalCount).toBe(0);
  } else {
    const list = await read(await listResponses(request(member, `/api/v1/questions/${questionId}/responses`), {
      params: Promise.resolve({ questionId }),
    }));
    expect(list.body.data).toMatchObject({ items: [{ id: post.id, content: null, publicationState: "hidden" }] });
    expect(list.text).not.toContain(secretBody);
  }

  const edited = await edit(author, post, "非表示中に本人が編集した本文", 2);
  expect(edited.body.data).toMatchObject({ version: 3, state: "hidden" });
  expect((await detail(member, post)).body.data).toMatchObject({ content: null });
  const restored = await change(manager, post, { expectedVersion: 3, visibility: "public" });
  expect(restored.body.data).toMatchObject({ resource: post, version: 4, state: "public" });
  expect((await detail(member, post)).body.data).toMatchObject({ content: { bodyMarkdown: "非表示中に本人が編集した本文" } });

  const { rows: audits } = await target.client.query(`
    SELECT id, action_type, target_type, public_reason, before_state, after_state FROM audit_logs
    WHERE target_id = $1 ORDER BY created_at
  `, [post.id]);
  expect(audits).toMatchObject([
    { action_type: `${type}.hidden`, target_type: type, public_reason: reason, before_state: { version: 1, publicationState: "public" },
      after_state: { version: 2, publicationState: "hidden" } },
    { action_type: `${type}.restored`, target_type: type, public_reason: null, before_state: { version: 3, publicationState: "hidden" },
      after_state: { version: 4, publicationState: "public" } },
  ]);
  const { rows: notifications } = await target.client.query(`
    SELECT recipient_id, event_key, public_message FROM notifications
    WHERE qa_question_id = $1 OR qa_response_id = $1
  `, [post.id]);
  expect(notifications).toEqual([{
    recipient_id: ids.get(author), event_key: `qa_hidden:${post.id}:${audits[0].id}`,
    public_message: expect.stringContaining(reason),
  }]);
  expect(JSON.stringify(notifications)).not.toContain(secretBody);
});

it.each(["question", "response"] as const)("SEC-09・SEC-10 %s がアプリ管理者の投稿なら学校管理者だけが非表示・復元できる", async (type) => {
  const questionId = await addQuestion(manager);
  const post = { type, id: type === "question" ? questionId : await addResponse(questionId, manager) };
  const hide = { expectedVersion: 1, visibility: "hidden", reason };
  const restore = { expectedVersion: 2, visibility: "public", reason: "確認後に公開" };
  const deniedHide = await change(manager, post, hide);
  expect(deniedHide.status).toBe(403);
  expect(deniedHide.text).not.toContain(secretBody);
  expect((await detail(manager, post)).body.data).toMatchObject({ capabilities: { canHide: false, canEdit: true } });
  expect((await change(school, post, hide)).status).toBe(200);
  const deniedRestore = await change(manager, post, restore);
  expect(deniedRestore.status).toBe(403);
  expect(deniedRestore.text).not.toContain(secretBody);
  expect((await detail(manager, post)).body.data).toMatchObject({ capabilities: { canRestore: false, canEdit: true } });
  expect((await change(school, post, restore)).body.data).toMatchObject({ state: "public", version: 3 });
});

it("AC-01 削除済みの質問は復元できず、再送も現在の管理権限で判定する", async () => {
  const hide = { expectedVersion: 1, visibility: "hidden", reason };
  const deleted = await change(school, { type: "question", id: await addQuestion(author, true) }, {
    expectedVersion: 1, visibility: "public",
  });
  expect(deleted.status).toBe(404);
  expect(deleted.text).not.toContain(secretBody);

  const post = { type: "question" as const, id: await addQuestion(member) };
  const key = randomUUID();
  expect((await change(manager, post, hide, key)).status).toBe(200);
  await target.client.query("UPDATE community_users SET app_manager = true WHERE user_id = $1", [ids.get(member)]);
  try {
    const denied = await change(manager, post, hide, key);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(secretBody);
    const restricted = await detail(manager, post);
    expect(restricted.body.data).toMatchObject({ content: null, capabilities: { canRestore: false } });
    expect(restricted.text).not.toContain(secretBody);
  } finally {
    await target.client.query("UPDATE community_users SET app_manager = false WHERE user_id = $1", [ids.get(member)]);
  }
});

it("AC-05 seed の案件で措置を記録し、別対象・対応済み・権限外の案件を拒否する", async () => {
  const { rows: [seedCase] } = await target.client.query<{ id: string; question_id: string; version: number }>(`
    SELECT c.id, t.question_id, c.version FROM report_cases c
    JOIN report_targets t ON t.id = c.target_id WHERE t.kind = 'question'
  `);
  const question = { type: "question" as const, id: seedCase.question_id };
  const response = { type: "response" as const, id: await addResponse(question.id) };
  const closed = await addCase(response, { closed: true });
  const restricted = await addCase(response, { schoolOnly: true });
  const hide = { expectedVersion: 1, visibility: "hidden", reason };
  for (const [caseId, status, code] of [
    [seedCase.id, 422, "VALIDATION_FAILED"], [closed, 409, "CASE_CLOSED"], [restricted, 404, "NOT_FOUND"],
  ] as const) {
    const result = await change(manager, response, { ...hide, sourceCaseId: caseId });
    expect(result.status).toBe(status);
    expect(result.body.error?.code).toBe(code);
    expect(result.text).not.toContain(secretBody);
  }
  const key = randomUUID();
  const seeded = await change(manager, question, { ...hide, sourceCaseId: seedCase.id }, key);
  expect(seeded.body.data).toMatchObject({ state: "hidden", version: 2 });
  expect((await change(manager, question, { ...hide, sourceCaseId: seedCase.id }, key)).body.meta?.replayed).toBe(true);
  const restored = await change(school, question, { expectedVersion: 2, visibility: "public", sourceCaseId: seedCase.id });
  expect(restored.body.data).toMatchObject({ state: "public", version: 3 });
  const { rows: [history] } = await target.client.query(`
    SELECT c.version, array_agg(a.action_type ORDER BY a.created_at) AS actions FROM report_cases c
    JOIN report_actions a ON a.case_id = c.id WHERE c.id = $1 GROUP BY c.id
  `, [seedCase.id]);
  expect(history).toEqual({ version: seedCase.version + 2, actions: ["status_changed", "qa_hidden", "qa_restored"] });

  // 学校専用案件で学校管理者が措置すると、非表示にする直前の公開本文を保全する。
  const hidden = await change(school, response, { ...hide, sourceCaseId: restricted });
  expect(hidden.body.data).toMatchObject({ state: "hidden" });
  const { rows: evidence } = await target.client.query(`
    SELECT e.snapshot FROM report_case_evidence ce JOIN evidence_snapshots e ON e.id = ce.evidence_id
    WHERE ce.case_id = $1
  `, [restricted]);
  expect(evidence).toMatchObject([{ snapshot: { bodyMarkdown: secretBody } }]);
});

it("AC-03 通知の記録に失敗すると投稿更新・証拠・案件履歴・監査を取り消し、同じキーで再試行できる", async () => {
  const post = { type: "question" as const, id: await addQuestion() };
  const sourceCaseId = await addCase(post, { handoff: true });
  const input = { expectedVersion: 1, visibility: "hidden", reason, sourceCaseId };
  const key = randomUUID();
  await target.client.query("ALTER TABLE notifications ADD CONSTRAINT qa_notification_failure CHECK (kind <> 'qa_hidden') NOT VALID");
  try {
    const failed = await change(school, post, input, key);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(secretBody);
    expect((await detail(member, post)).body.data).toMatchObject({ version: 1, publicationState: "public" });
    const { rows: [saved] } = await target.client.query(`
      SELECT c.version,
        EXISTS (SELECT 1 FROM report_actions a WHERE a.case_id = c.id) AS action,
        EXISTS (SELECT 1 FROM report_case_evidence ce WHERE ce.case_id = c.id) AS evidence,
        EXISTS (SELECT 1 FROM audit_logs l WHERE l.target_id = $2) AS audit
      FROM report_cases c WHERE c.id = $1
    `, [sourceCaseId, post.id]);
    expect(saved).toEqual({ version: 1, action: false, evidence: false, audit: false });
  } finally {
    await target.client.query("ALTER TABLE notifications DROP CONSTRAINT qa_notification_failure");
  }
  expect((await change(school, post, input, key)).body.data).toMatchObject({ version: 2, state: "hidden" });
});

it("AC-05 対応済み案件での新規操作は拒否し、確定済みの操作の再送には元の結果だけを返す", async () => {
  const post = { type: "question" as const, id: await addQuestion() };
  const sourceCaseId = await addCase(post);
  const hide = { expectedVersion: 1, visibility: "hidden", reason, sourceCaseId };
  const key = randomUUID();
  const original = await change(manager, post, hide, key);
  expect(original.status).toBe(200);
  expect(original.body.data).toMatchObject({ resource: post, version: 2, state: "hidden" });

  await target.client.query(`
    UPDATE report_cases SET status = 'closed', closed_at = now(), updated_at = now(), version = version + 1
    WHERE id = $1
  `, [sourceCaseId]);
  const rejected = await change(manager, post, { expectedVersion: 2, visibility: "public", sourceCaseId });
  expect(rejected.status).toBe(409);
  expect(rejected.body.error?.code).toBe("CASE_CLOSED");

  const replay = await change(manager, post, hide, key);
  expect(replay.status).toBe(200);
  expect(replay.body.meta?.replayed).toBe(true);
  expect(replay.body.data).toEqual(original.body.data);
  const { rows: [saved] } = await target.client.query(`
    SELECT c.version,
      (SELECT count(*)::int FROM report_actions a WHERE a.case_id = c.id) AS actions,
      (SELECT count(*)::int FROM notifications n WHERE n.qa_question_id = $2::uuid) AS notifications,
      (SELECT count(*)::int FROM audit_logs l WHERE l.target_id = $2::text) AS audits
    FROM report_cases c WHERE c.id = $1
  `, [sourceCaseId, post.id]);
  expect(saved).toEqual({ version: 3, actions: 1, notifications: 1, audits: 1 });
});
