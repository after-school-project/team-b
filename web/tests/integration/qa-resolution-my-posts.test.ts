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
 * 解決状態の変更と自分のQ&A投稿の一覧（#9 ⑥、API-QA-12・13）。実際の Route Handler を実セッションで呼ぶ。
 * AC-11：質問者本人だけが未解決・解決済みを何度でも変更でき、解決済みの質問にも回答できる。
 * AC-12：本人の質問・回答・コメント・返信だけを一覧表示でき、種類で絞り込める。
 */

const origin = "https://school.example";
/** このテストが追加する質問の本文に付ける文字列。seed の質問と区別する。 */
const marker = "解決と本人一覧の検証用データ";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let questionRoute: typeof import("../../src/app/api/v1/questions/[questionId]/route");
let resolutionRoute: typeof import("../../src/app/api/v1/questions/[questionId]/resolution/route");
let responsesRoute: typeof import("../../src/app/api/v1/questions/[questionId]/responses/route");
let myPostsRoute: typeof import("../../src/app/api/v1/me/qa-posts/route");
let ipCounter = 0;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-qa-resolution-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user" WHERE username IS NOT NULL');
  for (const { id, username } of rows) ids.set(username, id);
  questionRoute = await import("../../src/app/api/v1/questions/[questionId]/route");
  resolutionRoute = await import("../../src/app/api/v1/questions/[questionId]/resolution/route");
  responsesRoute = await import("../../src/app/api/v1/questions/[questionId]/responses/route");
  myPostsRoute = await import("../../src/app/api/v1/me/qa-posts/route");
});

afterEach(async () => {
  const questions = "SELECT id FROM qa_questions WHERE body_markdown LIKE $1";
  const responses = `SELECT id FROM qa_responses WHERE question_id IN (${questions})`;
  const values = [`%${marker}%`];
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

type Item = {
  id: string; kind: string; questionId: string; questionTitle: string | null; questionState: string;
  excerpt: string | null; createdAt: string; targetPath: string;
};
type Body = {
  data?: { items?: Item[]; resource?: { type: string; id: string }; version?: number; state?: string;
    resolution?: string; capabilities?: Record<string, boolean> };
  error?: { code: string };
  meta: { replayed?: boolean; page?: { totalCount: number; hasMore: boolean; nextCursor: string | null; limit: number } };
};

async function result(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function resolve(viewer: string, questionId: string, body: object, requestKey = randomUUID()) {
  const request = new Request(`${origin}/api/v1/questions/${questionId}/resolution`, {
    method: "PATCH",
    headers: {
      Cookie: await cookieFor(viewer), Origin: origin, "Content-Type": "application/json", "Idempotency-Key": requestKey,
    },
    body: JSON.stringify(body),
  });
  return result(await resolutionRoute.PATCH(request, { params: Promise.resolve({ questionId }) }));
}

async function getQuestion(viewer: string, questionId: string) {
  return result(await questionRoute.GET(
    new Request(`${origin}/api/v1/questions/${questionId}`, { headers: { Cookie: await cookieFor(viewer) } }),
    { params: Promise.resolve({ questionId }) },
  ));
}

async function answer(viewer: string, questionId: string) {
  const request = new Request(`${origin}/api/v1/questions/${questionId}/responses`, {
    method: "POST",
    headers: {
      Cookie: await cookieFor(viewer), Origin: origin, "Content-Type": "application/json", "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ kind: "answer", bodyMarkdown: "解決後の回答" }),
  });
  return result(await responsesRoute.POST(request, { params: Promise.resolve({ questionId }) }));
}

async function myPosts(viewer: string, query: Record<string, string> = {}) {
  const url = `${origin}/api/v1/me/qa-posts?${new URLSearchParams(query)}`;
  return result(await myPostsRoute.GET(new Request(url, { headers: { Cookie: await cookieFor(viewer) } }), { params: Promise.resolve({}) }));
}

async function addQuestion(state: {
  author?: string; title?: string; body?: string; hidden?: boolean; deleted?: boolean; resolution?: string; createdAt?: string;
} = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, resolution, forced_hidden_at,
      deleted_at, created_at)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = 'learning'), $2, $3, '質問者名', $4,
      CASE WHEN $5 THEN now() END, CASE WHEN $6 THEN now() END, coalesce($7::timestamptz, now()))
    RETURNING id
  `, [id(state.author ?? "poc_s001"), state.title ?? "解決する質問", `${state.body ?? "質問の本文"} ${marker}`,
    state.resolution ?? "open", state.hidden ?? false, state.deleted ?? false, state.createdAt ?? null]);
  return rows[0].id;
}

async function addResponse(questionId: string, state: {
  author?: string; parent?: string; kind?: string; body?: string; hidden?: boolean; deleted?: boolean; createdAt?: string;
} = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label, created_at,
      forced_hidden_at, deleted_at)
    VALUES ($1, $2, $3, $4, $5, '回答者名', coalesce($6::timestamptz, now()), CASE WHEN $7 THEN now() END,
      CASE WHEN $8 THEN now() END) RETURNING id
  `, [questionId, id(state.author ?? "poc_s002"), state.kind ?? (state.parent ? "reply" : "answer"), state.parent ?? null,
    state.body ?? "回答の本文", state.createdAt ?? null, state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

async function questionRow(questionId: string) {
  const { rows: [row] } = await target.client.query<{ version: number; resolution: string }>(
    "SELECT version, resolution FROM qa_questions WHERE id = $1", [questionId]);
  return row;
}

async function withUser<T>(username: string, change: string, restore: string, run: () => Promise<T>) {
  await target.client.query(`UPDATE community_users SET ${change} WHERE user_id = $1`, [id(username)]);
  try {
    return await run();
  } finally {
    await target.client.query(`UPDATE community_users SET ${restore} WHERE user_id = $1`, [id(username)]);
  }
}

describe("API-QA-12 解決状態の変更（AC-11）", () => {
  it("AC-11 質問者本人は未解決・解決済みを何度でも変更でき、版番号を進める。解決済みの質問にも回答できる", async () => {
    const questionId = await addQuestion();
    const resolved = await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "resolved" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ resource: { type: "question", id: questionId }, version: 2, state: "resolved" });
    expect((await getQuestion("poc_a001", questionId)).body.data?.resolution).toBe("resolved");
    expect((await answer("poc_a001", questionId)).status).toBe(201);

    const reopened = await resolve("poc_s001", questionId, { expectedVersion: 2, resolution: "open" });
    expect(reopened.body.data).toMatchObject({ version: 3, state: "open" });
    expect((await resolve("poc_s001", questionId, { expectedVersion: 3, resolution: "resolved" })).body.data)
      .toMatchObject({ version: 4, state: "resolved" });
    expect(await questionRow(questionId)).toEqual({ version: 4, resolution: "resolved" });
  });

  it("本人には canResolve を返し、他人・管理者・プロフィール非表示中の本人には返さない", async () => {
    const questionId = await addQuestion();
    expect((await getQuestion("poc_s001", questionId)).body.data?.capabilities).toMatchObject({ canResolve: true });
    for (const viewer of ["poc_a001", "poc_school", "poc_staff_mgr"]) {
      expect((await getQuestion(viewer, questionId)).body.data?.capabilities).toMatchObject({ canResolve: false });
    }
    const hiddenProfile = await addQuestion({ author: "poc_hidden" });
    expect((await getQuestion("poc_hidden", hiddenProfile)).body.data?.capabilities).toMatchObject({ canResolve: false });
  });

  it("他人・管理者・存在しない質問・削除済みの質問は404、プロフィール非表示中は403。いずれも変更しない", async () => {
    const questionId = await addQuestion();
    for (const viewer of ["poc_a001", "poc_school", "poc_s_mgr", "poc_staff_mgr"]) {
      const { status, text } = await resolve(viewer, questionId, { expectedVersion: 1, resolution: "resolved" });
      expect(status, viewer).toBe(404);
      expect(text).not.toContain("解決する質問");
    }
    expect((await resolve("poc_s001", randomUUID(), { expectedVersion: 1, resolution: "resolved" })).status).toBe(404);
    const deleted = await addQuestion({ deleted: true });
    expect((await resolve("poc_s001", deleted, { expectedVersion: 1, resolution: "resolved" })).status).toBe(404);
    const hiddenProfile = await addQuestion({ author: "poc_hidden" });
    const restricted = await resolve("poc_hidden", hiddenProfile, { expectedVersion: 1, resolution: "resolved" });
    expect(restricted.status).toBe(403);
    expect(restricted.body.error?.code).toBe("PROFILE_WRITE_RESTRICTED");
    expect(await questionRow(questionId)).toEqual({ version: 1, resolution: "open" });
    expect(await questionRow(hiddenProfile)).toEqual({ version: 1, resolution: "open" });
  });

  it("今と同じ状態は409 STATE_CONFLICT、古い版は409 VERSION_CONFLICT、値・項目の誤りは422", async () => {
    const questionId = await addQuestion();
    const same = await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "open" });
    expect(same.status).toBe(409);
    expect(same.body.error?.code).toBe("STATE_CONFLICT");
    const stale = await resolve("poc_s001", questionId, { expectedVersion: 5, resolution: "resolved" });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");
    for (const body of [{ expectedVersion: 1 }, { expectedVersion: 1, resolution: "closed" }, { resolution: "resolved" },
      { expectedVersion: 1, resolution: "resolved", title: "余分な項目" }]) {
      const { status, body: response } = await resolve("poc_s001", questionId, body);
      expect(status, JSON.stringify(body)).toBe(422);
      expect(response.error?.code).toBe("VALIDATION_FAILED");
    }
    expect(await questionRow(questionId)).toEqual({ version: 1, resolution: "open" });
  });

  it("強制非表示中の質問も本人は変更できる。停止中は変更できない", async () => {
    const hidden = await addQuestion({ hidden: true });
    expect((await resolve("poc_s001", hidden, { expectedVersion: 1, resolution: "resolved" })).body.data?.state).toBe("resolved");
    const questionId = await addQuestion();
    await withUser("poc_s001", "account_status = 'suspended'", "account_status = 'active'", async () => {
      expect((await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "resolved" })).status).toBe(403);
    });
    expect(await questionRow(questionId)).toEqual({ version: 1, resolution: "open" });
  });

  it("同じ再送キーの再送は最初の結果を返して版を進めない。再送時もプロフィール非表示を拒否する", async () => {
    const questionId = await addQuestion();
    const key = randomUUID();
    const first = await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "resolved" }, key);
    const replay = await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "resolved" }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.meta.replayed).toBe(true);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await questionRow(questionId)).toEqual({ version: 2, resolution: "resolved" });
    await withUser("poc_s001", "profile_state = 'hidden'", "profile_state = 'public'", async () => {
      expect((await resolve("poc_s001", questionId, { expectedVersion: 1, resolution: "resolved" }, key)).status).toBe(403);
    });
  });
});

describe("API-QA-13 自分のQ&A投稿の一覧（AC-12）", () => {
  it("AC-12 本人の質問・回答・コメント・返信だけを作成日時の降順で返し、QA-02 への導線を付ける", async () => {
    const own = await addQuestion({ author: "poc_s002", title: "自分の質問", body: "# 見出し\n\n**強調**した本文",
      createdAt: "2026-11-01T00:00:00Z" });
    const others = await addQuestion({ author: "poc_s001", title: "他人の質問", createdAt: "2026-11-01T00:00:01Z" });
    const ownAnswer = await addResponse(others, { body: "自分の回答", createdAt: "2026-11-01T00:00:02Z" });
    const othersComment = await addResponse(others, { author: "poc_a001", kind: "comment", parent: ownAnswer,
      body: "他人のコメント", createdAt: "2026-11-01T00:00:03Z" });
    const ownReply = await addResponse(others, { parent: othersComment, body: "自分の返信", createdAt: "2026-11-01T00:00:04Z" });
    const ownComment = await addResponse(own, { kind: "comment", body: "自分の質問へのコメント", createdAt: "2026-11-01T00:00:05Z" });

    const { status, body, text } = await myPosts("poc_s002");
    expect(status).toBe(200);
    expect(body.data!.items).toEqual([
      { id: ownComment, kind: "comment", questionId: own, questionTitle: "自分の質問", questionState: "public",
        excerpt: "自分の質問へのコメント", createdAt: "2026-11-01T00:00:05.000Z", targetPath: `/questions/${own}#response-${ownComment}` },
      { id: ownReply, kind: "reply", questionId: others, questionTitle: "他人の質問", questionState: "public",
        excerpt: "自分の返信", createdAt: "2026-11-01T00:00:04.000Z", targetPath: `/questions/${others}#response-${ownReply}` },
      { id: ownAnswer, kind: "answer", questionId: others, questionTitle: "他人の質問", questionState: "public",
        excerpt: "自分の回答", createdAt: "2026-11-01T00:00:02.000Z", targetPath: `/questions/${others}#response-${ownAnswer}` },
      { id: own, kind: "question", questionId: own, questionTitle: "自分の質問", questionState: "public",
        excerpt: `見出し 強調した本文 ${marker}`, createdAt: "2026-11-01T00:00:00.000Z", targetPath: `/questions/${own}` },
    ]);
    expect(body.meta.page).toMatchObject({ totalCount: 4, hasMore: false, nextCursor: null });
    expect(text).not.toContain("他人のコメント");
  });

  it("AC-12 種類で絞り込め、件数も絞り込みに合わせる", async () => {
    const own = await addQuestion({ author: "poc_s002" });
    const others = await addQuestion();
    const ownAnswer = await addResponse(others);
    await addResponse(others, { kind: "comment", parent: ownAnswer });
    await addResponse(own, { kind: "comment" });
    await addResponse(others, { parent: ownAnswer });
    const counts = { question: 1, answer: 1, comment: 2, reply: 1 };
    for (const [kind, total] of Object.entries(counts)) {
      const { body } = await myPosts("poc_s002", { kind });
      expect(body.data!.items!.map((item) => item.kind), kind).toEqual(Array(total).fill(kind));
      expect(body.meta.page?.totalCount).toBe(total);
    }
    expect((await myPosts("poc_s002", { kind: "all" })).body.meta.page?.totalCount).toBe(5);
    for (const query of [{ kind: "notice" }, { state: "all" }] as Record<string, string>[]) {
      expect((await myPosts("poc_s002", query)).status, JSON.stringify(query)).toBe(400);
    }
  });

  it("自分で削除した投稿は出さず、削除済みの質問の下に残る自分の回答等は題名なしで出す。強制非表示中の自分の投稿も出す", async () => {
    await addQuestion({ author: "poc_s002", title: "削除した自分の質問", deleted: true });
    const deletedQuestion = await addQuestion({ title: "削除された他人の質問", deleted: true });
    const remaining = await addResponse(deletedQuestion, { body: "残っている自分の回答" });
    await addResponse(deletedQuestion, { kind: "comment", parent: remaining, body: "削除した自分のコメント", deleted: true });
    const hiddenQuestion = await addQuestion({ title: "非表示の他人の質問", hidden: true });
    const underHidden = await addResponse(hiddenQuestion, { body: "非表示の質問への回答" });
    const ownHidden = await addQuestion({ author: "poc_s002", title: "非表示の自分の質問", hidden: true });

    const { body, text } = await myPosts("poc_s002");
    expect(body.data!.items!.map(({ id, questionTitle, questionState }) => [id, questionTitle, questionState])).toEqual([
      [ownHidden, "非表示の自分の質問", "hidden"],
      [underHidden, null, "hidden"],
      [remaining, null, "deleted"],
    ]);
    expect(body.meta.page?.totalCount).toBe(3);
    for (const secret of ["削除した自分の質問", "削除された他人の質問", "削除した自分のコメント", "非表示の他人の質問"]) {
      expect(text).not.toContain(secret);
    }
    expect(body.data!.items![2].targetPath).toBe(`/questions/${deletedQuestion}#response-${remaining}`);
  });

  it("管理できる管理者は、自分の回答等の親の強制非表示の質問の題名を見られる", async () => {
    const hiddenQuestion = await addQuestion({ title: "管理対象の非表示の質問", hidden: true });
    const answerId = await addResponse(hiddenQuestion, { author: "poc_school" });
    const { body } = await myPosts("poc_school", { kind: "answer" });
    expect(body.data!.items!.find(({ id }) => id === answerId)).toMatchObject({
      questionTitle: "管理対象の非表示の質問", questionState: "hidden",
    });
  });

  it("作成日時・IDの降順で、同じ日時でもページ間の重複・欠落がない。カーソルは条件と利用者に結び付く", async () => {
    const others = await addQuestion();
    const at = "2026-10-01T00:00:00Z";
    const created = [await addQuestion({ author: "poc_s002", createdAt: at })];
    for (let index = 0; index < 4; index += 1) created.push(await addResponse(others, { createdAt: at }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { body } = await myPosts("poc_s002", { limit: "2", ...(cursor ? { cursor } : {}) });
      seen.push(...body.data!.items!.map(({ id }) => id));
      expect(body.meta.page?.totalCount).toBe(5);
      cursor = body.meta.page?.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set(created));
    expect(seen).toEqual([...seen].sort().reverse());

    const first = (await myPosts("poc_s002", { limit: "2" })).body.meta.page!.nextCursor!;
    expect((await myPosts("poc_s002", { limit: "2", kind: "answer", cursor: first })).body.error?.code).toBe("INVALID_CURSOR");
    expect((await myPosts("poc_a001", { limit: "2", cursor: first })).body.error?.code).toBe("INVALID_CURSOR");
  });

  it("プロフィール非表示中の本人も一覧を見られ、停止中・未ログインは利用できない", async () => {
    const own = await addQuestion({ author: "poc_hidden" });
    expect((await myPosts("poc_hidden")).body.data!.items!.map(({ id }) => id)).toContain(own);
    await withUser("poc_s002", "account_status = 'suspended'", "account_status = 'active'", async () => {
      expect((await myPosts("poc_s002")).status).toBe(403);
    });
    const anonymous = await myPostsRoute.GET(new Request(`${origin}/api/v1/me/qa-posts`), { params: Promise.resolve({}) });
    expect(anonymous.status).toBe(401);
  });
});
