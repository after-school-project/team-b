import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import * as auth from "../../src/db/auth-schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";
import * as community from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 他の利用者の公開プロフィールと卒業生検索（#8 ③④、API-PRO-03・04）。実際の Route Handler を実セッションで呼ぶ。
 * AC-04：他人向け応答・検索に `self` 項目の値が含まれない。
 * AC-05：承認済み利用者が公開許可された項目だけを閲覧でき、非表示は状態案内のみになる。
 * AC-06：掲載希望・公開中の卒業生・卒業予定者だけが検索結果に表示され、非表示・掲載希望なしが除外される。
 */

const { communityUsers, identityRecords, profileRevisions, profiles } = community;
const schema = { ...auth, ...content, ...community, ...moderation };
const origin = "https://school.example";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let credentialsDir: string;
let credentials: Record<string, string>;
let userRoute: typeof import("../../src/app/api/v1/users/[userId]/profile/route");
let alumniRoute: typeof import("../../src/app/api/v1/alumni/route");
let ipCounter = 0;
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool, { schema }) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  db = drizzle(pool, { schema });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-public-profile-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  for (const { id, username } of await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user)) {
    if (username) ids.set(username, id);
  }
  userRoute = await import("../../src/app/api/v1/users/[userId]/profile/route");
  alumniRoute = await import("../../src/app/api/v1/alumni/route");
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

type Body = {
  data?: Record<string, unknown> & { items?: Array<Record<string, unknown> & { userId: string }> };
  error?: { code: string };
  meta: { page?: { totalCount: number; hasMore: boolean; nextCursor: string | null; limit: number } };
};

async function getUser(viewer: string | null, userId: string) {
  const headers: HeadersInit = viewer ? { Cookie: await cookieFor(viewer) } : {};
  const response = await userRoute.GET(new Request(`${origin}/api/v1/users/${encodeURIComponent(userId)}/profile`, { headers }), {
    params: Promise.resolve({ userId }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function search(viewer: string, query: Record<string, string> = {}) {
  const url = new URL(`${origin}/api/v1/alumni`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await alumniRoute.GET(new Request(url, { headers: { Cookie: await cookieFor(viewer) } }), {});
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

const names = (body: Body) => (body.data?.items ?? []).map((item) => (item.fields as { displayName: string }).displayName);

/** 現在版の任意項目と公開範囲を差し替える（本人の保存と同じく新しい版を作る）。 */
async function setOptionalFields(username: string, optionalValues: Record<string, string>, fieldVisibility: Record<string, string>) {
  const userId = id(username);
  const [current] = await db.select().from(profileRevisions)
    .innerJoin(profiles, eq(profiles.currentRevisionId, profileRevisions.id)).where(eq(profiles.userId, userId));
  const { rows: [{ next }] } = await pool.query<{ next: number }>(
    "SELECT max(revision_no) + 1 AS next FROM profile_revisions WHERE user_id = $1", [userId]);
  const [revision] = await db.insert(profileRevisions).values({
    ...current.profile_revisions, id: undefined, revisionNo: next, optionalValues, fieldVisibility, createdAt: new Date(),
  }).returning({ id: profileRevisions.id });
  await db.update(profiles).set({ currentRevisionId: revision.id }).where(eq(profiles.userId, userId));
}

describe("API-PRO-03 公開プロフィール", () => {
  it("AC-04・AC-05 公開を許可された項目だけを返し、本人のみの項目・本人確認情報・管理権限を含めない", async () => {
    const { status, body, text } = await getUser("poc_s001", id("poc_a001"));
    expect(status).toBe(200);
    expect(body.data).toEqual({
      userId: id("poc_a001"), state: "public", baseRole: "alumni", isGraduating: false,
      fields: {
        displayName: "あおい", department: "IT学科（架空）", entryYear: null, graduationYear: 2026,
        optionalFields: { bio: { value: "開発用のサンプルプロフィールです。", visibility: "members" } },
      },
      capabilities: { canReport: true },
    });
    expect(text).not.toContain("Web開発"); // 本人のみの関心分野はキーごと返さない
    expect(text).not.toContain("interests");
    const [identity] = await db.select().from(identityRecords).where(eq(identityRecords.userId, id("poc_a001")));
    expect(text).not.toContain(identity.privateRealName);
    expect(text).not.toContain(identity.schoolReference);
    expect(text).not.toMatch(/schoolManager|appManager|accountStatus|profileState|searchOptIn/);
  });

  it("本人と学校管理者のプロフィールには通報の入口を出さない", async () => {
    expect((await getUser("poc_a001", id("poc_a001"))).body.data).toMatchObject({
      state: "public", capabilities: { canReport: false },
      fields: { optionalFields: { bio: { visibility: "members" } } },
    });
    // 本人が見ても、他人向けの表示（本人のみの項目を含めない）にする。
    expect((await getUser("poc_a001", id("poc_a001"))).text).not.toContain("Web開発");
    expect((await getUser("poc_s001", id("poc_school"))).body.data).toMatchObject({ capabilities: { canReport: false } });
  });

  it("AC-05 非表示のプロフィールは状態案内だけを返す", async () => {
    const { status, body, text } = await getUser("poc_s001", id("poc_hidden"));
    expect(status).toBe(200);
    expect(body.data).toEqual({ userId: id("poc_hidden"), state: "hidden" });
    expect(text).not.toContain("ゆう");
    expect(text).not.toContain("IT学科");
  });

  it("存在しない利用者は404、形式の誤ったIDは400、未認証は401、停止中は403", async () => {
    expect((await getUser("poc_s001", "no-such-user")).status).toBe(404);
    expect((await getUser("poc_s001", "a/b")).status).toBe(400);
    expect((await getUser(null, id("poc_a001"))).status).toBe(401);
    const suspended = await getUser("poc_suspended", id("poc_a001"));
    expect(suspended.status).toBe(403);
    expect(suspended.text).not.toContain("あおい");
  });
});

describe("API-PRO-04 卒業生検索", () => {
  beforeEach(async () => {
    // 掲載希望・公開状態を seed に戻し、検索の対象外の組合せも用意する。
    await db.update(profiles).set({ searchOptIn: true }).where(sql`${profiles.userId} IN (${id("poc_a001")}, ${id("poc_s002")}, ${id("poc_hidden")})`);
    await db.update(communityUsers).set({ profileState: "public" }).where(eq(communityUsers.userId, id("poc_a001")));
    // 在校生（卒業予定でない）・学校職員・停止中の利用者が掲載を希望しても、検索の対象にしない。
    await db.update(profiles).set({ searchOptIn: true })
      .where(sql`${profiles.userId} IN (${id("poc_s001")}, ${id("poc_staff")})`);
  });

  it("AC-06 掲載希望があり公開中の卒業生・卒業予定者だけを、公開表示名の昇順で返す", async () => {
    const { status, body } = await search("poc_s001");
    expect(status).toBe(200);
    expect(names(body)).toEqual(["あおい", "みなと"]);
    expect(body.meta.page).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null, limit: 20 });
    expect(body.data?.items?.[1]).toMatchObject({ baseRole: "student", isGraduating: true });
  });

  it("AC-06 非表示・掲載希望なしの利用者を、結果からも件数からも除く", async () => {
    await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, id("poc_a001")));
    await db.update(profiles).set({ searchOptIn: false }).where(eq(profiles.userId, id("poc_s002")));
    const { body, text } = await search("poc_s001");
    expect(names(body)).toEqual([]);
    expect(body.meta.page?.totalCount).toBe(0);
    expect(text).not.toContain("あおい");
  });

  it("AC-04 キーワードは公開表示名・学科と公開範囲が「全員」の項目だけに一致し、本人のみの項目は結果・件数に影響しない", async () => {
    // seed の関心分野「Web開発」は全員「自分だけ」。
    expect((await search("poc_s001", { q: "Web開発" })).body.meta.page?.totalCount).toBe(0);
    expect(names((await search("poc_s001", { q: "サンプル" })).body)).toEqual(["あおい", "みなと"]);
    expect(names((await search("poc_s001", { q: "みな" })).body)).toEqual(["みなと"]);
    expect(names((await search("poc_s001", { q: "IT学科" })).body)).toEqual(["あおい", "みなと"]);

    await setOptionalFields("poc_a001", { interests: "Web開発" }, { interests: "members" });
    const found = await search("poc_s001", { q: "web開発" });
    expect(names(found.body)).toEqual(["あおい"]);
    expect(found.body.meta.page?.totalCount).toBe(1);
  });

  it("LIKE の特殊文字は文字そのものとして扱う", async () => {
    expect((await search("poc_s001", { q: "%" })).body.meta.page?.totalCount).toBe(0);
    expect((await search("poc_s001", { q: "_" })).body.meta.page?.totalCount).toBe(0);
  });

  it("学科・入学年度・卒業年度で絞り込む", async () => {
    expect(names((await search("poc_s001", { department: "IT学科（架空）", graduationYear: "2026" })).body))
      .toEqual(["あおい", "みなと"]);
    expect((await search("poc_s001", { department: "IT学科" })).body.meta.page?.totalCount).toBe(0);
    expect((await search("poc_s001", { graduationYear: "2025" })).body.meta.page?.totalCount).toBe(0);
    expect((await search("poc_s001", { entryYear: "2020" })).body.meta.page?.totalCount).toBe(0);
  });

  it("カーソルで次のページを取得し、条件・閲覧者が変わったカーソルは受け付けない", async () => {
    const first = await search("poc_s001", { limit: "1" });
    expect(names(first.body)).toEqual(["あおい"]);
    expect(first.body.meta.page).toMatchObject({ totalCount: 2, hasMore: true });
    const cursor = first.body.meta.page!.nextCursor!;

    const second = await search("poc_s001", { limit: "1", cursor });
    expect(names(second.body)).toEqual(["みなと"]);
    expect(second.body.meta.page).toMatchObject({ totalCount: 2, hasMore: false, nextCursor: null });

    expect((await search("poc_s001", { limit: "1", cursor, q: "みな" })).body.error?.code).toBe("INVALID_CURSOR");
    expect((await search("poc_a001", { limit: "1", cursor })).body.error?.code).toBe("INVALID_CURSOR");
  });

  it("検索条件の形式の誤りは400にする", async () => {
    const invalid: Array<Record<string, string>> = [
      { q: "あ".repeat(101) }, { q: "   " }, { entryYear: "26" }, { graduationYear: "２０２６" }, { sort: "name" },
    ];
    for (const query of invalid) {
      const { status, body } = await search("poc_s001", query);
      expect(status, JSON.stringify(query)).toBe(400);
      expect(body.error?.code).toBe("BAD_REQUEST");
    }
  });

  it("停止中の利用者は検索できない", async () => {
    const response = await alumniRoute.GET(new Request(`${origin}/api/v1/alumni`, {
      headers: { Cookie: await cookieFor("poc_suspended") },
    }), {});
    expect(response.status).toBe(403);
  });
});
