import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import * as auth from "../../src/db/auth-schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";
import * as community from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * マイプロフィールの取得・保存（#8 ①②と⑤の本人側、API-PRO-01・02）。実際の Route Handler を実セッションで呼ぶ。
 * AC-01：本人が表示・更新でき、文字数・未知の項目を検証し、所属等を改ざんできない。
 * AC-02：古い版番号は409、保存前の版は履歴として残る。
 * AC-03：項目ごとに公開範囲を設定でき、未設定は本人のみ。
 * AC-08（本人側）：非表示中の本人が修正し、再公開申請を作成・更新できる。
 */

const { communityUsers, profileReviews, profileRevisions, profiles, identityRecords } = community;
const { evidenceSnapshots, reportCaseEvidence, reportCases, reportTargets } = moderation;
const schema = { ...auth, ...content, ...community, ...moderation };
const origin = "https://school.example";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let credentialsDir: string;
let credentials: Record<string, string>;
let route: typeof import("../../src/app/api/v1/me/profile/route");
let ipCounter = 0;
const ids = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool, { schema }) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  db = drizzle(pool, { schema });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-my-profile-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  for (const { id, username } of await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user)) {
    if (username) ids.set(username, id);
  }
  route = await import("../../src/app/api/v1/me/profile/route");
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

async function logIn(username: string) {
  const { POST } = await import("../../src/app/api/auth/[...auth]/route");
  const response = await POST(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${++ipCounter}` },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
}

type Body = { data?: Record<string, unknown>; error?: { code: string; fields?: Array<{ path: string; code: string }> } };

async function getProfile(cookie: string) {
  const response = await route.GET(new Request(origin + "/api/v1/me/profile", { headers: { Cookie: cookie } }), {});
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function patchProfile(cookie: string, body: unknown, key = `profile-${randomUUID()}`) {
  const response = await route.PATCH(new Request(origin + "/api/v1/me/profile", {
    method: "PATCH",
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  }), {});
  return { status: response.status, body: await response.json() as Body };
}

async function revisionsOf(userId: string) {
  return db.select().from(profileRevisions).where(eq(profileRevisions.userId, userId)).orderBy(asc(profileRevisions.revisionNo));
}

async function profileOf(userId: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  return row;
}

describe("API-PRO-01 マイプロフィールの取得", () => {
  it("本人の公開状態・所属・全任意項目と公開範囲を返し、本人確認情報と管理権限を含めない", async () => {
    const cookie = await logIn("poc_a001");
    const { status, body, text } = await getProfile(cookie);
    expect(status).toBe(200);
    expect(body.data).toEqual({
      userId: id("poc_a001"), version: 1, profileState: "public", baseRole: "alumni", isGraduating: false,
      searchOptIn: true,
      fields: {
        displayName: "あおい", department: "IT学科（架空）", entryYear: null, graduationYear: 2026,
        optionalFields: {
          bio: { value: "開発用のサンプルプロフィールです。", visibility: "members" },
          // 本人には公開範囲が「自分だけ」の項目も返す。
          interests: { value: "Web開発", visibility: "self" },
        },
      },
      review: null,
    });
    const [identity] = await db.select().from(identityRecords).where(eq(identityRecords.userId, id("poc_a001")));
    expect(text).not.toContain(identity.privateRealName);
    expect(text).not.toContain(identity.schoolReference);
    expect(text).not.toMatch(/schoolManager|appManager|accountStatus/);
  });

  it("未認証は401、停止中は403で、プロフィールを返さない", async () => {
    const anonymous = await route.GET(new Request(origin + "/api/v1/me/profile"), {});
    expect(anonymous.status).toBe(401);
    const suspended = await getProfile(await logIn("poc_suspended"));
    expect(suspended.status).toBe(403);
    expect(suspended.body.error?.code).toBe("ACCOUNT_SUSPENDED");
    expect(suspended.text).not.toContain("りく");
  });
});

describe("API-PRO-02 マイプロフィールの保存", () => {
  it("AC-01・AC-02・AC-03 保存ごとに新しい版を作り、保存前の版を残し、指定した項目だけを置き換える", async () => {
    const userId = id("poc_a001");
    const cookie = await logIn("poc_a001");
    const before = await revisionsOf(userId);

    const saved = await patchProfile(cookie, {
      expectedVersion: 1,
      displayName: "  あおい（卒業生）  ",
      searchOptIn: false,
      optionalFields: {
        occupation: { value: "Webエンジニア", visibility: "members" },
        interests: { visibility: "members" },
        bio: { value: "" },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ resource: { type: "profile", id: userId }, version: 2, state: "public" });

    const revisions = await revisionsOf(userId);
    expect(revisions.map(({ revisionNo }) => revisionNo)).toEqual([...before.map(({ revisionNo }) => revisionNo), 2]);
    expect(revisions[0]).toEqual(before[0]); // 保存前の版は変わらない
    const latest = revisions.at(-1)!;
    expect(latest).toMatchObject({
      displayName: "あおい（卒業生）", department: "IT学科（架空）", graduationYear: 2026,
      optionalValues: { occupation: "Webエンジニア", interests: "Web開発" },
      fieldVisibility: { bio: "members", occupation: "members", interests: "members" },
    });
    expect(await profileOf(userId)).toMatchObject({ currentRevisionId: latest.id, version: 2, searchOptIn: false });

    const { body } = await getProfile(cookie);
    expect((body.data as { fields: { optionalFields: unknown } }).fields.optionalFields).toEqual({
      bio: { visibility: "members" },
      occupation: { value: "Webエンジニア", visibility: "members" },
      interests: { value: "Web開発", visibility: "members" },
    });
  });

  it("AC-03 公開範囲を指定しない任意項目は本人のみとして扱う", async () => {
    const cookie = await logIn("poc_s001");
    const version = (await profileOf(id("poc_s001"))).version;
    expect((await patchProfile(cookie, { expectedVersion: version, optionalFields: { occupation: { value: "学生" } } })).status).toBe(200);
    const { body } = await getProfile(cookie);
    expect((body.data as { fields: { optionalFields: Record<string, unknown> } }).fields.optionalFields.occupation)
      .toEqual({ value: "学生", visibility: "self" });
  });

  it("AC-02 古い版番号の保存は409で拒否し、新しい版を作らない", async () => {
    const userId = id("poc_a001");
    const cookie = await logIn("poc_a001");
    const before = await revisionsOf(userId);
    const stale = await patchProfile(cookie, { expectedVersion: 1, displayName: "古い画面からの保存" });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");
    expect(await revisionsOf(userId)).toEqual(before);
  });

  it("同じ再送キーでの再送は、保存を繰り返さずに同じ結果を返す", async () => {
    const userId = id("poc_s001");
    const cookie = await logIn("poc_s001");
    const { version } = await profileOf(userId);
    const key = `retry-${randomUUID()}`;
    const body = { expectedVersion: version, displayName: "はる（再送）" };
    const first = await patchProfile(cookie, body, key);
    const again = await patchProfile(cookie, body, key);
    expect(first.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect((await profileOf(userId)).version).toBe(version + 1);
  });

  it("AC-01 未定義の項目・所属・文字数超過・null・変更なしは422で拒否し、何も保存しない", async () => {
    const userId = id("poc_s002");
    const cookie = await logIn("poc_s002");
    const before = { revisions: await revisionsOf(userId), profile: await profileOf(userId) };
    const cases: Array<[unknown, string]> = [
      [{ expectedVersion: 1, department: "別の学科" }, ""],
      [{ expectedVersion: 1, displayName: "あ", baseRole: "alumni" }, ""],
      [{ expectedVersion: 1, displayName: "あ".repeat(51) }, "displayName"],
      [{ expectedVersion: 1, optionalFields: { bio: { value: "あ".repeat(1001) } } }, "optionalFields.bio.value"],
      [{ expectedVersion: 1, optionalFields: { bio: { value: null } } }, "optionalFields.bio.value"],
      [{ expectedVersion: 1 }, ""],
    ];
    for (const [input, path] of cases) {
      const { status, body } = await patchProfile(cookie, input);
      expect(status, JSON.stringify(input)).toBe(422);
      expect(body.error?.fields?.map((field) => field.path)).toContain(path);
    }
    expect(await revisionsOf(userId)).toEqual(before.revisions);
    expect(await profileOf(userId)).toEqual(before.profile);
    const [user] = await db.select({ baseRole: communityUsers.baseRole }).from(communityUsers).where(eq(communityUsers.userId, userId));
    expect(user.baseRole).toBe("student");
  });

  it("Origin のない保存要求は403で拒否する", async () => {
    const cookie = await logIn("poc_s002");
    const response = await route.PATCH(new Request(origin + "/api/v1/me/profile", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": `no-origin-${randomUUID()}` },
      body: JSON.stringify({ expectedVersion: 1, displayName: "送信元なし" }),
    }), {});
    expect(response.status).toBe(403);
  });
});

describe("非表示中の保存と再公開申請（#8 ⑤の本人側、AC-08）", () => {
  it("非表示中の保存は、審査中の申請の対象版を新しい版に差し替えて版番号を上げる", async () => {
    const userId = id("poc_hidden");
    const cookie = await logIn("poc_hidden");
    const [pending] = await db.select().from(profileReviews)
      .where(and(eq(profileReviews.userId, userId), eq(profileReviews.status, "pending")));
    const { version } = await profileOf(userId);

    const saved = await patchProfile(cookie, { expectedVersion: version, displayName: "ゆう（修正）" });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ state: "hidden", version: version + 1 });

    const reviews = await db.select().from(profileReviews).where(eq(profileReviews.userId, userId));
    expect(reviews).toHaveLength(1);
    const latest = (await revisionsOf(userId)).at(-1)!;
    expect(reviews[0]).toMatchObject({
      id: pending.id, status: "pending", revisionId: latest.id, version: pending.version + 1,
    });
    const { body } = await getProfile(cookie);
    expect(body.data).toMatchObject({
      profileState: "hidden",
      review: { id: pending.id, status: "pending", version: pending.version + 1, decisionReason: null },
    });
  });

  it("却下の後に保存すると、新しい再公開申請を作る", async () => {
    const userId = id("poc_hidden");
    const cookie = await logIn("poc_hidden");
    await db.update(profileReviews).set({
      status: "rejected", reviewerId: id("poc_school"), decidedAt: new Date(), decisionReason: "連絡先が残っています。",
    }).where(and(eq(profileReviews.userId, userId), eq(profileReviews.status, "pending")));
    const rejected = (await getProfile(cookie)).body.data as { version: number; review: { status: string; decisionReason: string } };
    expect(rejected.review).toMatchObject({ status: "rejected", decisionReason: "連絡先が残っています。" });

    expect((await patchProfile(cookie, { expectedVersion: rejected.version, optionalFields: { bio: { value: "修正しました。" } } })).status)
      .toBe(200);
    const reviews = await db.select().from(profileReviews).where(eq(profileReviews.userId, userId))
      .orderBy(asc(profileReviews.submittedAt));
    expect(reviews.map(({ status }) => status)).toEqual(["rejected", "pending"]);
    expect(reviews[1].revisionId).toBe((await revisionsOf(userId)).at(-1)!.id);
  });
});

describe("保存前の内容の通報証拠（#47 の保全処理の利用）", () => {
  async function openCase(kind: "profile" | "account", userId: string) {
    const [reportTarget] = await db.insert(reportTargets).values({ kind, subjectUserId: userId }).returning();
    const [reportCase] = await db.insert(reportCases).values({ targetId: reportTarget.id, assigneeId: id("poc_school") }).returning();
    return reportCase.id;
  }
  async function evidenceOf(caseId: string) {
    return db.select({ snapshot: evidenceSnapshots.snapshot }).from(reportCaseEvidence)
      .innerJoin(evidenceSnapshots, eq(evidenceSnapshots.id, reportCaseEvidence.evidenceId))
      .where(eq(reportCaseEvidence.caseId, caseId));
  }

  it("公開中の保存では、変更前の公開内容をプロフィールとアカウントの案件に保全する", async () => {
    const userId = id("poc_staff");
    const profileCase = await openCase("profile", userId);
    const accountCase = await openCase("account", userId);
    const cookie = await logIn("poc_staff");
    const { version } = await profileOf(userId);
    expect((await patchProfile(cookie, { expectedVersion: version, displayName: "変更後の職員名" })).status).toBe(200);

    const [profileEvidence] = await evidenceOf(profileCase);
    const [accountEvidence] = await evidenceOf(accountCase);
    expect(profileEvidence.snapshot).toMatchObject({ fields: { displayName: "学校職員（サンプル）" } });
    expect(accountEvidence.snapshot).toEqual({ userId, displayName: "学校職員（サンプル）", baseRole: "staff" });
    // 本人のみの任意項目（seed の関心分野）は証拠に含めない。
    expect(JSON.stringify(profileEvidence.snapshot)).not.toContain("Web開発");
  });
});
