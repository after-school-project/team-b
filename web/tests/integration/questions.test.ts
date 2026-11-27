import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { qaCategoryFixtures } from "../../scripts/fixtures";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { noCapabilities } from "../../src/auth/capabilities";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * Q&Aのカテゴリー・一覧・検索・質問の詳細（#9 ①③、API-QA-01・02・04）。実際の Route Handler を実セッションで呼ぶ。
 * AC-01：4カテゴリーと公開中の質問一覧を、キーワード・カテゴリー・解決状態で絞り込める。
 * AC-02：削除済み・強制非表示の質問を一覧・検索・件数に含めず、ページ間で順序が安定する。
 * AC-05・AC-06・AC-10：質問を表示でき、削除済み・非表示の本文・著者・版番号を権限外の利用者へ返さない（質問本体の部分）。
 * SEC-01：未承認の利用者は一覧・検索APIを利用できない。
 */

const origin = "https://school.example";
const seedTitle = "チーム開発で最初に揃えておくとよいことは？";
/** このテストが追加する質問のタイトルと本文に付ける文字列。一覧を seed の質問と区別する。 */
const marker = "検証用データ";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let credentialsDir: string;
let credentials: Record<string, string>;
let categoriesRoute: typeof import("../../src/app/api/v1/question-categories/route");
let questionsRoute: typeof import("../../src/app/api/v1/questions/route");
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
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-questions-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  const { rows } = await target.client.query<{ id: string; username: string }>('SELECT id, username FROM "user" WHERE username IS NOT NULL');
  for (const { id, username } of rows) ids.set(username, id);
  categoriesRoute = await import("../../src/app/api/v1/question-categories/route");
  questionsRoute = await import("../../src/app/api/v1/questions/route");
  questionRoute = await import("../../src/app/api/v1/questions/[questionId]/route");
});

afterEach(async () => {
  await target.client.query("DELETE FROM qa_responses WHERE question_id IN (SELECT id FROM qa_questions WHERE body_markdown LIKE $1)", [`%${marker}%`]);
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

type Item = { id: string; title: string; responseCount: number } & Record<string, unknown>;
type Body = {
  data?: { items?: Item[] } & Record<string, unknown>;
  error?: { code: string };
  meta: { replayed?: boolean; page?: { totalCount: number; hasMore: boolean; nextCursor: string | null; limit: number } };
};

async function result(response: Response) {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function headersFor(viewer: string | null): Promise<HeadersInit> {
  return viewer ? { Cookie: await cookieFor(viewer) } : {};
}

async function getCategories(viewer: string | null, search = "") {
  return result(await categoriesRoute.GET(new Request(`${origin}/api/v1/question-categories${search}`, { headers: await headersFor(viewer) }), {}));
}

async function search(viewer: string | null, query: Record<string, string> | string = {}) {
  const url = `${origin}/api/v1/questions?${new URLSearchParams(query)}`;
  return result(await questionsRoute.GET(new Request(url, { headers: await headersFor(viewer) }), {}));
}

async function getQuestion(viewer: string | null, questionId: string) {
  return result(await questionRoute.GET(
    new Request(`${origin}/api/v1/questions/${encodeURIComponent(questionId)}`, { headers: await headersFor(viewer) }),
    { params: Promise.resolve({ questionId }) },
  ));
}

const newQuestionBody = { title: " 質問の題名 ", bodyMarkdown: `**質問** ${marker}`, categoryCode: "learning" };

async function writeQuestion(viewer: string, body: object, questionId?: string, requestKey = randomUUID()) {
  const path = "/api/v1/questions" + (questionId ? `/${questionId}` : "");
  const request = new Request(origin + path, {
    method: questionId ? "PATCH" : "POST",
    headers: {
      Cookie: await cookieFor(viewer), Origin: origin,
      "Content-Type": "application/json", "Idempotency-Key": requestKey,
    },
    body: JSON.stringify(body),
  });
  return result(questionId
    ? await questionRoute.PATCH(request, { params: Promise.resolve({ questionId }) })
    : await questionsRoute.POST(request, {}));
}

describe("質問の作成・編集（AC-03・AC-04）", () => {
  it.each(["poc_s001", "poc_a001", "poc_staff"])("公開プロフィールの %s が投稿でき、再送で増えない", async (actor) => {
    const key = randomUUID();
    const created = await writeQuestion(actor, newQuestionBody, undefined, key);
    expect(created.status).toBe(201);
    const { id: questionId } = created.body.data?.resource as { id: string };
    expect(created.body.data).toMatchObject({ resource: { type: "question", id: questionId }, state: "public", version: 1 });
    expect((await getQuestion(actor, questionId)).body.data).toMatchObject({
      content: { title: "質問の題名", bodyMarkdown: newQuestionBody.bodyMarkdown, category: { code: "learning" } },
      author: { userId: id(actor) }, capabilities: { canEdit: true },
    });
    const replay = await writeQuestion(actor, newQuestionBody, undefined, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(created.body.data);
    expect(replay.body.meta.replayed).toBe(true);
    const { rowCount } = await target.client.query("SELECT id FROM qa_questions WHERE author_id = $1 AND body_markdown = $2",
      [id(actor), newQuestionBody.bodyMarkdown]);
    expect(rowCount).toBe(1);
  });

  it("本人の編集を1回だけ確定し、古い版を409にする", async () => {
    const questionId = await addQuestion({ hidden: true });
    const body = { title: "更新後", categoryCode: "chat", expectedVersion: 7 };
    const key = randomUUID();
    const edited = await writeQuestion("poc_s001", body, questionId, key);
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ state: "hidden", version: 8 });
    const replay = await writeQuestion("poc_s001", body, questionId, key);
    expect(replay.body.meta.replayed).toBe(true);
    expect(replay.body.data).toEqual(edited.body.data);
    const stale = await writeQuestion("poc_s001", { ...body, title: "上書き内容" }, questionId);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");
    expect((await getQuestion("poc_s001", questionId)).body.data).toMatchObject({
      content: { title: "更新後", category: { code: "chat" } }, publicationState: "hidden", version: 8,
    });
    await target.client.query("UPDATE qa_questions SET deleted_at = now() WHERE id = $1", [questionId]);
    expect((await writeQuestion("poc_s001", body, questionId, key)).status).toBe(404);
  });

  it("他人・削除済み・プロフィール非表示の操作を拒否する", async () => {
    const questionId = await addQuestion();
    const deleted = await addQuestion({ deleted: true });
    const ownedByHidden = await addQuestion({ author: "poc_hidden" });
    const patch = { title: "更新後", expectedVersion: 7 };
    for (const [actor, targetId] of [["poc_school", questionId], ["poc_s001", deleted]]) {
      const denied = await writeQuestion(actor, patch, targetId);
      expect(denied.status).toBe(404);
      expect(denied.text).not.toContain(marker);
    }
    for (const denied of [await writeQuestion("poc_hidden", newQuestionBody), await writeQuestion("poc_hidden", patch, ownedByHidden)]) {
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe("PROFILE_WRITE_RESTRICTED");
    }
    expect((await getQuestion("poc_hidden", ownedByHidden)).body.data?.capabilities).toEqual({ ...noCapabilities, canDelete: true });
  });

  it("必須項目・上限・カテゴリー・制限Markdownを検証する", async () => {
    const questionId = await addQuestion();
    expect((await writeQuestion("poc_s001", {}, undefined)).status).toBe(422);
    expect((await writeQuestion("poc_s001", { expectedVersion: 7 }, questionId)).status).toBe(422);
    for (const invalid of [
      { title: "あ".repeat(101) }, { bodyMarkdown: "あ".repeat(10001) }, { categoryCode: "unknown" },
      { bodyMarkdown: "<div>HTML</div>" }, { bodyMarkdown: "[リンク](javascript:noop)" },
    ]) {
      expect((await writeQuestion("poc_s001", { ...newQuestionBody, ...invalid })).status).toBe(422);
      expect((await writeQuestion("poc_s001", { ...invalid, expectedVersion: 7 }, questionId)).status).toBe(422);
    }
    expect((await getQuestion("poc_s001", questionId)).body.data?.version).toBe(7);
  });
});

type NewQuestion = {
  title?: string; body?: string; author?: string; category?: string; resolution?: string;
  createdAt?: string; hidden?: boolean; deleted?: boolean;
};

async function addQuestion(question: NewQuestion = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_questions (author_id, category_id, title, body_markdown, author_label, resolution, created_at, forced_hidden_at, deleted_at, version)
    VALUES ($1, (SELECT id FROM qa_categories WHERE code = $2), $3, $4, '投稿時の表示名', $5, coalesce($6::timestamptz, now()),
      CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() END, 7)
    RETURNING id
  `, [id(question.author ?? "poc_s001"), question.category ?? "learning", question.title ?? "題名", `${question.body ?? "本文"} ${marker}`,
    question.resolution ?? "open", question.createdAt ?? null, question.hidden ?? false, question.deleted ?? false]);
  return rows[0].id;
}

async function addResponse(questionId: string, state: { parent?: string; hidden?: boolean; deleted?: boolean } = {}): Promise<string> {
  const { rows } = await target.client.query<{ id: string }>(`
    INSERT INTO qa_responses (question_id, author_id, kind, parent_response_id, body_markdown, author_label, forced_hidden_at, deleted_at)
    VALUES ($1, $2, $3, $4, '回答の本文', 'あおい', CASE WHEN $5 THEN now() END, CASE WHEN $6 THEN now() END) RETURNING id
  `, [questionId, id("poc_a001"), state.parent ? "reply" : "answer", state.parent ?? null, state.hidden ?? false, state.deleted ?? false]);
  return rows[0].id;
}

const titles = (body: Body) => (body.data?.items ?? []).map((item) => item.title);

describe("SEC-01：未承認・未認証・停止中の利用者はQ&Aの一覧・検索APIを利用できない", () => {
  const calls = [
    () => getCategories("poc_s002"), () => search("poc_s002"), () => search("poc_s002", { q: "チーム開発" }),
  ];

  it.each([
    ["学校による利用資格確認が未完了", "eligibility_status = 'pending'", "eligibility_status = 'verified'"],
    ["アカウント発行が未完了", "provisioning_status = 'pending'", "provisioning_status = 'ready'"],
  ])("SEC-01 %sの利用者は403とし、一覧・件数・カテゴリー・質問の内容を返さない", async (_label, change, restore) => {
    await cookieFor("poc_s002");
    const questionId = await addQuestion({ title: "秘密の題名" });
    await target.client.query(`UPDATE community_users SET ${change} WHERE user_id = $1`, [id("poc_s002")]);
    try {
      for (const call of [...calls, () => getQuestion("poc_s002", questionId)]) {
        const { status, body, text } = await call();
        expect({ status, code: body.error?.code }).toEqual({ status: 403, code: "ACCOUNT_NOT_READY" });
        expect(Object.keys(body).sort()).toEqual(["error", "meta"]);
        expect(body.meta.page).toBeUndefined();
        for (const secret of [seedTitle, "秘密の題名", marker, "技術・学習"]) expect(text).not.toContain(secret);
      }
    } finally {
      await target.client.query(`UPDATE community_users SET ${restore} WHERE user_id = $1`, [id("poc_s002")]);
    }
    for (const call of calls) expect((await call()).status).toBe(200);
  });

  it("SEC-01 未認証は401、停止中は403とし、内容を返さない", async () => {
    const questionId = await addQuestion({ title: "秘密の題名" });
    for (const [viewer, status, code] of [[null, 401, "AUTH_REQUIRED"], ["poc_suspended", 403, "ACCOUNT_SUSPENDED"]] as const) {
      for (const response of [await getCategories(viewer), await search(viewer), await getQuestion(viewer, questionId)]) {
        expect({ status: response.status, code: response.body.error?.code }).toEqual({ status, code });
        for (const secret of [seedTitle, "秘密の題名", marker, "技術・学習"]) expect(response.text).not.toContain(secret);
      }
    }
  });
});

describe("API-QA-01 カテゴリー", () => {
  it("AC-01 マイグレーションだけで4件が揃い、開発seedの値と一致する。既存の行のID・名称は変えない", async () => {
    const empty = await isolatedDatabase();
    try {
      await migrateDatabase(empty.client);
      const { rows } = await empty.client.query<{ code: string; name: string }>(
        "SELECT code, name FROM qa_categories ORDER BY array_position(ARRAY['career', 'learning', 'projects', 'chat'], code)");
      expect(rows).toEqual(qaCategoryFixtures);
    } finally {
      await empty.dispose();
    }

    // マイグレーションより前に、同じコードの行を別の名称で作っていた環境。
    const existing = await isolatedDatabase();
    try {
      await existing.client.query("CREATE TABLE qa_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL)");
      const { rows: [{ id }] } = await existing.client.query<{ id: string }>(
        "INSERT INTO qa_categories (code, name) VALUES ('chat', '仮の名称') RETURNING id");
      const sql = await readFile(join("drizzle", "0003_qa-categories.sql"), "utf8");
      await existing.client.query(sql);
      await existing.client.query(sql); // 同じ処理を繰り返しても増えない。
      const { rows } = await existing.client.query("SELECT id, code, name FROM qa_categories ORDER BY code");
      expect(rows).toHaveLength(4);
      expect(rows.find((row) => row.code === "chat")).toEqual({ id, code: "chat", name: "仮の名称" });
    } finally {
      await existing.dispose();
    }
  });

  it("AC-01 4件を設計書の順に返し、初期データと一致する。ほかのカテゴリーは含めない", async () => {
    await target.client.query("INSERT INTO qa_categories (code, name) VALUES ('other', '対象外')");
    try {
      const { status, body } = await getCategories("poc_s001");
      expect(status).toBe(200);
      expect(body.data).toEqual({ items: qaCategoryFixtures });
      expect(qaCategoryFixtures).toEqual([
        { code: "career", name: "就職・キャリア" }, { code: "learning", name: "技術・学習" },
        { code: "projects", name: "制作・プロジェクト" }, { code: "chat", name: "雑談" },
      ]);
    } finally {
      await target.client.query("DELETE FROM qa_categories WHERE code = 'other'");
    }
  });

  it("未定義のクエリーは400、プロフィール非表示中の利用者も閲覧できる", async () => {
    expect((await getCategories("poc_s001", "?limit=1")).status).toBe(400);
    expect((await getCategories("poc_hidden")).status).toBe(200);
  });
});

describe("API-QA-02 一覧・検索", () => {
  it("AC-01 QuestionListItem の項目だけを返す。本文・版番号・非公開の状態を含めない", async () => {
    const questionId = await addQuestion({ title: "題名A", category: "career", resolution: "resolved", createdAt: "2026-11-01T00:00:00.123456Z" });
    const { status, body } = await search("poc_s002", { q: marker });
    expect(status).toBe(200);
    expect(body.data?.items).toEqual([{
      id: questionId, title: "題名A", category: { code: "career", name: "就職・キャリア" },
      author: { userId: id("poc_s001"), displayName: "投稿時の表示名" }, resolution: "resolved", responseCount: 0,
      createdAt: "2026-11-01T00:00:00.123Z", updatedAt: expect.stringMatching(/Z$/),
    }]);
    expect(body.meta.page).toEqual({ limit: 20, hasMore: false, nextCursor: null, totalCount: 1 });
  });

  it("AC-01 キーワードはタイトルと本文の部分一致で、英字の大小を区別せず、LIKEの特殊文字を文字として扱う", async () => {
    await addQuestion({ title: "React の質問", body: "x" });
    await addQuestion({ title: "ほか", body: "REACTについて" });
    await addQuestion({ title: "達成率100%_\\完了", body: "x" });
    await addQuestion({ title: "達成率100点", body: "x" });
    expect(titles((await search("poc_s002", { q: " react " })).body).sort()).toEqual(["React の質問", "ほか"]);
    expect(titles((await search("poc_s002", { q: "100%" })).body)).toEqual(["達成率100%_\\完了"]);
    expect(titles((await search("poc_s002", { q: "%_\\" })).body)).toEqual(["達成率100%_\\完了"]);
    // 著者名・カテゴリー名・回答の本文は、キーワードの対象にしない。
    for (const q of ["投稿時の表示名", "技術・学習", "起動手順"]) expect((await search("poc_s002", { q })).body.meta.page?.totalCount).toBe(0);
  });

  it("AC-01 カテゴリーと解決状態で絞り込め、組み合わせはANDになる", async () => {
    for (const [title, category, resolution] of [
      ["就職・未", "career", "open"], ["就職・済", "career", "resolved"], ["雑談・未", "chat", "open"], ["制作・未", "projects", "open"],
    ]) await addQuestion({ title, category, resolution });
    const find = async (query: Record<string, string>) => {
      const { body } = await search("poc_s002", { q: marker, ...query });
      expect(body.meta.page?.totalCount).toBe(body.data?.items?.length);
      return titles(body).sort();
    };
    expect(await find({ category: "career" })).toEqual(["就職・未", "就職・済"].sort());
    expect(await find({ resolution: "open" })).toEqual(["制作・未", "就職・未", "雑談・未"].sort());
    expect(await find({ resolution: "resolved" })).toEqual(["就職・済"]);
    expect(await find({ category: "career", resolution: "open" })).toEqual(["就職・未"]);
    expect(await find({ category: "learning" })).toEqual([]);
    expect(await find({ resolution: "all" })).toHaveLength(4);
  });

  it("AC-02 強制非表示・削除済みの質問を、本人と管理者に対しても一覧・検索・件数に含めない", async () => {
    await addQuestion({ title: "公開" });
    await addQuestion({ title: "強制非表示の題名", hidden: true });
    await addQuestion({ title: "削除済みの題名", deleted: true });
    await addQuestion({ title: "両方の題名", hidden: true, deleted: true });
    const total = (await search("poc_s002")).body.meta.page!.totalCount;
    for (const viewer of ["poc_s001", "poc_s002", "poc_school", "poc_s_mgr"]) {
      for (const query of [{}, { q: marker }, { q: "の題名" }, { category: "learning" }, { resolution: "open" }] as Record<string, string>[]) {
        const { body, text } = await search(viewer, query);
        expect(text).not.toContain("の題名");
        expect(body.meta.page?.totalCount).toBe(body.data?.items?.length);
      }
      expect((await search(viewer)).body.meta.page?.totalCount).toBe(total);
      expect(titles((await search(viewer, { q: marker })).body)).toEqual(["公開"]);
    }
  });

  it("AC-02 回答の件数に、強制非表示・削除済みの回答と、ほかの質問の回答を含めない", async () => {
    const first = await addQuestion({ title: "回答あり", createdAt: "2026-11-02T00:00:00Z" });
    const second = await addQuestion({ title: "回答なし", createdAt: "2026-11-01T00:00:00Z" });
    const answer = await addResponse(first);
    await addResponse(first, { parent: answer });
    await addResponse(first, { hidden: true });
    const deleted = await addResponse(first, { deleted: true });
    await addResponse(first, { parent: deleted }); // 削除済みの回答への返信は、残存する投稿として数える。
    await addResponse(second, { hidden: true });
    const { body } = await search("poc_s002", { q: marker });
    expect(body.data?.items?.map(({ title, responseCount }) => [title, responseCount])).toEqual([["回答あり", 3], ["回答なし", 0]]);
  });

  it("AC-02 作成日時・IDの降順で、同じ日時・同じミリ秒内でもページ間の重複・欠落がない", async () => {
    const expected: string[] = [];
    for (const createdAt of ["2026-11-03T00:00:00.000200Z", "2026-11-03T00:00:00.000100Z"]) {
      expected.push(...(await Promise.all([1, 2, 3].map(() => addQuestion({ createdAt })))).sort().reverse());
    }
    await addQuestion({ createdAt: "2026-11-03T00:00:00.000150Z", hidden: true });
    for (const limit of [1, 2, 4, 6]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const { status, body }: { status: number; body: Body } = await search("poc_s002",
          { q: marker, limit: String(limit), ...(cursor ? { cursor } : {}) });
        expect(status).toBe(200);
        expect(body.meta.page?.totalCount).toBe(6);
        expect(body.data!.items!.length).toBeLessThanOrEqual(limit);
        seen.push(...body.data!.items!.map((item) => item.id));
        cursor = body.meta.page!.nextCursor;
        expect(body.meta.page!.hasMore).toBe(cursor !== null);
      } while (cursor);
      expect(seen).toEqual(expected);
    }
  });

  it("AC-02 ページの間に削除・非表示になった質問を、続きのページと件数に含めない", async () => {
    for (const day of ["03", "02", "01"]) await addQuestion({ title: `題名${day}`, createdAt: `2026-11-${day}T00:00:00Z` });
    const first = (await search("poc_s002", { q: marker, limit: "1" })).body;
    await target.client.query("UPDATE qa_questions SET deleted_at = now() WHERE title = '題名02'");
    const next = (await search("poc_s002", { q: marker, limit: "1", cursor: first.meta.page!.nextCursor! })).body;
    expect(titles(next)).toEqual(["題名01"]);
    expect(next.meta.page).toMatchObject({ totalCount: 2, hasMore: false });
  });

  it("条件・利用者を変えたカーソルと改ざんしたカーソルは400 INVALID_CURSOR", async () => {
    await addQuestion({ createdAt: "2026-11-02T00:00:00Z" });
    await addQuestion({ createdAt: "2026-11-01T00:00:00Z" });
    const cursor = (await search("poc_s002", { q: marker, limit: "1" })).body.meta.page!.nextCursor!;
    for (const [viewer, query] of [
      ["poc_s002", { q: "本文", cursor }], ["poc_s002", { q: marker, category: "learning", cursor }],
      ["poc_s002", { q: marker, resolution: "open", cursor }], ["poc_s001", { q: marker, cursor }],
      ["poc_s002", { q: marker, cursor: cursor.slice(0, -2) + "AA" }], ["poc_s002", { q: marker, cursor: "x" }],
    ] as const) {
      const { status, body } = await search(viewer, query);
      expect({ status, code: body.error?.code }).toEqual({ status: 400, code: "INVALID_CURSOR" });
    }
  });

  it.each([
    "category=unknown", "category=", "category=Career", "resolution=closed", "resolution=", "q=", "q=%20", `q=${"a".repeat(101)}`,
    "q=%00", "limit=0", "limit=51", "limit=1.5", "authorId=x", "q=a&q=b", "deleted=true",
  ])("形式の誤ったクエリー %s は400", async (query) => {
    const { status, body } = await search("poc_s001", query);
    expect({ status, code: body.error?.code }).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  it("プロフィール非表示中の利用者も閲覧でき、未定義のメソッドは405", async () => {
    expect(titles((await search("poc_hidden")).body)).toContain(seedTitle);
    const response = await questionsRoute.DELETE(new Request(`${origin}/api/v1/questions`, { method: "DELETE" }), {});
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("GET");
  });
});

describe("API-QA-04 質問の詳細", () => {
  const withheld = {
    content: null, author: null, resolution: null, version: null, createdAt: null, updatedAt: null, capabilities: noCapabilities,
  };

  it("AC-05 公開中の質問の内容を返す。編集・削除・解決状態の変更は本人だけに示し、ほかの操作は本人・管理者にも示さない", async () => {
    const questionId = await addQuestion({ title: "題名B", body: "# 見出し", category: "chat" });
    const view = async (viewer: string) => (await getQuestion(viewer, questionId)).body.data!;
    const respondable = { ...noCapabilities, canRespond: true };
    expect(await view("poc_s002")).toEqual({
      id: questionId, publicationState: "public",
      content: { title: "題名B", bodyMarkdown: `# 見出し ${marker}`, category: { code: "chat", name: "雑談" } },
      author: { userId: id("poc_s001"), displayName: "投稿時の表示名" }, resolution: "open", version: 7,
      createdAt: expect.stringMatching(/Z$/), updatedAt: expect.stringMatching(/Z$/),
      capabilities: respondable,
    });
    expect((await view("poc_s001")).capabilities).toEqual({ ...respondable, canEdit: true, canDelete: true, canResolve: true });
    for (const viewer of ["poc_school", "poc_s_mgr"]) {
      expect((await view(viewer)).capabilities, viewer).toEqual(respondable);
    }
    // プロフィール非表示中は回答・コメントできない（AC-08）。
    expect((await view("poc_hidden")).capabilities).toEqual(noCapabilities);
  });

  it("プロフィール非表示中のアプリ管理者には、強制非表示の質問の内容を返さない", async () => {
    const questionId = await addQuestion({ hidden: true });
    await target.client.query("UPDATE community_users SET profile_state = 'hidden' WHERE user_id = $1", [id("poc_s_mgr")]);
    try {
      expect((await getQuestion("poc_s_mgr", questionId)).body.data).toEqual({ id: questionId, publicationState: "hidden", ...withheld });
    } finally {
      await target.client.query("UPDATE community_users SET profile_state = 'public' WHERE user_id = $1", [id("poc_s_mgr")]);
    }
  });

  it("AC-06・AC-10 削除済みの質問は、本人・管理者にも本文・著者・版番号・日時を返さない", async () => {
    for (const hidden of [false, true]) {
      const questionId = await addQuestion({ title: "削除済みの題名", deleted: true, hidden });
      for (const viewer of ["poc_s001", "poc_s002", "poc_school", "poc_s_mgr"]) {
        const { status, body, text } = await getQuestion(viewer, questionId);
        expect(status).toBe(200);
        expect(body.data).toEqual({ id: questionId, publicationState: "deleted", ...withheld });
        for (const secret of ["削除済みの題名", marker, "投稿時の表示名", id("poc_s001"), "技術・学習"]) expect(text).not.toContain(secret);
      }
    }
  });

  it("AC-06 強制非表示の質問は、本人と管理できる管理者だけに内容を返す", async () => {
    const questionId = await addQuestion({ title: "非表示の題名", hidden: true });
    for (const viewer of ["poc_s002", "poc_staff", "poc_hidden"]) {
      const { status, body, text } = await getQuestion(viewer, questionId);
      expect(status).toBe(200);
      expect(body.data).toEqual({ id: questionId, publicationState: "hidden", ...withheld });
      for (const secret of ["非表示の題名", marker, "投稿時の表示名", id("poc_s001"), "技術・学習"]) expect(text).not.toContain(secret);
    }
    const content = { title: "非表示の題名" };
    expect((await getQuestion("poc_s001", questionId)).body.data).toMatchObject({
      publicationState: "hidden", content, version: 7, capabilities: { ...noCapabilities, canEdit: true, canDelete: true, canResolve: true },
    });
    for (const viewer of ["poc_school", "poc_s_mgr", "poc_staff_mgr"]) {
      expect((await getQuestion(viewer, questionId)).body.data).toMatchObject({
        publicationState: "hidden", content, capabilities: noCapabilities,
      });
    }
  });

  it("AC-06 アプリ管理者の強制非表示の質問は、本人と学校管理者だけに内容を返す", async () => {
    const questionId = await addQuestion({ title: "非表示の題名", author: "poc_s_mgr", hidden: true });
    const { body, text } = await getQuestion("poc_a_mgr", questionId);
    expect(body.data).toEqual({ id: questionId, publicationState: "hidden", ...withheld });
    expect(text).not.toContain("非表示の題名");
    expect((await getQuestion("poc_school", questionId)).body.data)
      .toMatchObject({ content: { title: "非表示の題名" } });
    expect((await getQuestion("poc_s_mgr", questionId)).body.data).toMatchObject({ content: { title: "非表示の題名" } });
  });

  it("存在しない質問は404、形式の誤ったIDとクエリーは400、大文字のUUIDも受け付ける", async () => {
    expect((await getQuestion("poc_s001", randomUUID())).status).toBe(404);
    for (const value of ["x", "a/b", `${randomUUID()}x`]) expect((await getQuestion("poc_s001", value)).status).toBe(400);
    const questionId = await addQuestion();
    expect((await getQuestion("poc_s001", questionId.toUpperCase())).body.data?.id).toBe(questionId);
    const withQuery = await questionRoute.GET(
      new Request(`${origin}/api/v1/questions/${questionId}?x=1`, { headers: await headersFor("poc_s001") }),
      { params: Promise.resolve({ questionId }) },
    );
    expect(withQuery.status).toBe(400);
  });
});
