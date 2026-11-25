import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, inArray, like, ne } from "drizzle-orm";
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
 * 卒業区分の一括変更・指定修正・履歴（API-GR-01〜04）。実際の Route Handler を実セッションで呼ぶ（#8 ⑥）。
 * AC-10：学校管理者が卒業予定者を一括で卒業生へ変更でき、誤変更を履歴付きで修正できる。
 * AC-11：卒業区分変更後も利用者ID・投稿・管理権限が維持され、競合・途中失敗時に一部だけ変更されない。
 * SEC-28：学校管理者以外は卒業区分を修正できない。
 */

const { communityUsers, graduationChanges, identityRecords, profileRevisions, profiles, qaCategories } = community;
const { qaQuestions } = content;
const { auditLogs, evidenceSnapshots, notifications, operationReceipts, reportCaseEvidence, reportCases, reports, reportActions, reportTargets } = moderation;
const schema = { ...auth, ...content, ...community, ...moderation };
const origin = "https://school.example";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let credentialsDir: string;
let credentials: Record<string, string>;
let candidatesRoute: typeof import("../../src/app/api/v1/admin/graduation/candidates/route");
let changesRoute: typeof import("../../src/app/api/v1/admin/graduation/changes/route");
let correctionsRoute: typeof import("../../src/app/api/v1/admin/graduation/corrections/route");
let alumniRoute: typeof import("../../src/app/api/v1/alumni/route");
const ids = new Map<string, string>();
const cookies = new Map<string, string>();
const queries = vi.hoisted(() => [] as string[]);

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({
  db: drizzle(pool, { schema, logger: { logQuery: (query: string) => { queries.push(query); } } }),
}));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 8 });
  db = drizzle(pool, { schema });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-graduation-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  for (const row of await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user)) {
    if (row.username) ids.set(row.username, row.id);
  }
  candidatesRoute = await import("../../src/app/api/v1/admin/graduation/candidates/route");
  changesRoute = await import("../../src/app/api/v1/admin/graduation/changes/route");
  correctionsRoute = await import("../../src/app/api/v1/admin/graduation/corrections/route");
  alumniRoute = await import("../../src/app/api/v1/alumni/route");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

beforeEach(async () => {
  for (const table of [
    reports, reportCaseEvidence, evidenceSnapshots, reportActions, reportCases, reportTargets, notifications, auditLogs,
    operationReceipts, graduationChanges,
  ]) await db.delete(table);
  // テスト用に作った利用者（ID が g- で始まる）を消し、seed の利用者の区分・権限・状態を戻す。
  await db.delete(qaQuestions).where(like(qaQuestions.authorId, "g-%"));
  await db.delete(profiles).where(like(profiles.userId, "g-%"));
  await db.delete(profileRevisions).where(like(profileRevisions.userId, "g-%"));
  await db.delete(communityUsers).where(like(communityUsers.userId, "g-%"));
  await db.delete(auth.user).where(like(auth.user.id, "g-%"));
  for (const [username, values] of Object.entries({
    poc_s001: { baseRole: "student" }, poc_s002: { baseRole: "student", isGraduating: true }, poc_a001: { baseRole: "alumni" },
    poc_s_mgr: { baseRole: "student", appManager: true }, poc_a_mgr: { baseRole: "alumni", appManager: true },
  } as const)) {
    await db.update(communityUsers).set({ isGraduating: false, profileState: "public", ...values })
      .where(eq(communityUsers.userId, id(username)));
  }
  await db.update(communityUsers).set({ schoolManager: false }).where(ne(communityUsers.userId, id("poc_school")));
});

function id(username: string): string {
  const value = ids.get(username);
  if (!value) throw new Error(`${username} がありません`);
  return value;
}

async function logIn(username: string) {
  const cached = cookies.get(username);
  if (cached) return cached;
  const { POST } = await import("../../src/app/api/auth/[...auth]/route");
  const response = await POST(new Request(origin + "/api/auth/sign-in/username", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${cookies.size + 1}` },
    body: JSON.stringify({ username, password: credentials[username] }),
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith("__Secure-better-auth.session_token="))!.split(";", 1)[0];
  cookies.set(username, cookie);
  return cookie;
}

type Body = {
  data?: Record<string, unknown> & { items?: Array<Record<string, unknown>> };
  error?: { code: string; fields?: Array<{ path: string; code: string }> };
  meta: { replayed?: boolean; page?: { totalCount: number; nextCursor: string | null } };
};
type Result = { status: number; body: Body; text: string };

async function result(response: Response): Promise<Result> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function send(
  route: { GET: typeof changesRoute.GET; POST: typeof changesRoute.POST }, path: string, username: string | null,
  body?: unknown, key = `graduation-${randomUUID()}`,
): Promise<Result> {
  const cookie: Record<string, string> = username ? { Cookie: await logIn(username) } : {};
  const url = `${origin}/api/v1/admin/graduation/${path}`;
  return result(body === undefined
    ? await route.GET(new Request(url, { headers: cookie }), {})
    : await route.POST(new Request(url, {
      method: "POST",
      headers: { ...cookie, Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }), {}));
}

const candidates = (username: string | null, query = "") => send(candidatesRoute, `candidates${query}`, username);
const history = (username: string | null, query = "") => send(changesRoute, `changes${query}`, username);
const graduate = (username: string | null, body: unknown, key?: string) => send(changesRoute, "changes", username, body, key);
const correct = (username: string | null, body: unknown, key?: string) => send(correctionsRoute, "corrections", username, body, key);

async function userRow(userId: string) {
  const [row] = await db.select().from(communityUsers).where(eq(communityUsers.userId, userId));
  return row;
}

type NewUser = Partial<typeof communityUsers.$inferInsert> & { displayName?: string; department?: string; graduationYear?: number };

/** 卒業予定の在校生（既定）を作る。IDは g- で始める。 */
async function newUsers(specs: Array<NewUser & { userId: string }>) {
  await db.insert(auth.user).values(specs.map(({ userId }) => ({ id: userId, name: userId, email: `${userId}@example.invalid` })));
  await db.insert(communityUsers).values(specs.map(({ displayName, department, graduationYear, ...values }) => {
    void displayName; void department; void graduationYear;
    return {
      baseRole: "student" as const, isGraduating: values.baseRole === undefined || values.baseRole === "student",
      eligibilityStatus: "verified" as const, provisioningStatus: "ready" as const, ...values,
    };
  }));
  const revisions = await db.insert(profileRevisions).values(specs.map(({ userId, displayName, department, graduationYear }) => ({
    userId, revisionNo: 1, displayName: displayName ?? userId, department: department ?? "IT学科（架空）", graduationYear: graduationYear ?? 2027,
    optionalValues: { bio: "自己紹介", interests: "本人だけの関心" }, fieldVisibility: { bio: "members" as const, interests: "self" as const },
  }))).returning({ id: profileRevisions.id, userId: profileRevisions.userId });
  await db.insert(profiles).values(revisions.map((revision) => ({ userId: revision.userId, currentRevisionId: revision.id, searchOptIn: true })));
  return specs.map(({ userId }) => userId);
}

const targetsOf = async (userIds: string[]) => Promise.all(userIds.map(async (userId) => ({
  userId, expectedVersion: (await userRow(userId)).version,
})));

/** 変更・履歴・監査・操作記録が何も残っていないこと。 */
async function expectNothingChanged(before: Array<typeof communityUsers.$inferSelect>) {
  for (const row of before) expect(await userRow(row.userId)).toEqual(row);
  expect(await db.select().from(graduationChanges)).toEqual([]);
  expect(await db.select().from(auditLogs)).toEqual([]);
  expect(await db.select().from(operationReceipts)).toEqual([]);
}

describe("SEC-28 学校管理者以外は卒業区分を取得・変更・修正できない", () => {
  it.each(["poc_s001", "poc_s002", "poc_a001", "poc_staff", "poc_s_mgr", "poc_a_mgr", "poc_staff_mgr"])(
    "SEC-28 %s（本人・一般利用者・学校職員・アプリ管理者）には403で、対象の情報を返さない", async (actor) => {
      const before = [await userRow(id("poc_s002")), await userRow(id("poc_a001"))];
      const attempts = [
        await graduate(actor, { targets: await targetsOf([id("poc_s002")]), confirmed: true }),
        await correct(actor, {
          userId: id("poc_a001"), expectedVersion: before[1].version, baseRole: "student", isGraduating: true, confirmed: true,
        }),
        // 対象者の有無・版番号で応答を変えない。
        await graduate(actor, { targets: [{ userId: "no-such-user", expectedVersion: 9 }], confirmed: true }),
        await candidates(actor), await candidates(actor, "?mode=correction"), await history(actor),
      ];
      for (const attempt of attempts) {
        expect([attempt.status, attempt.body.error?.code]).toEqual([403, "FORBIDDEN"]);
        for (const secret of ["みなと", "あおい", id("poc_s002"), id("poc_a001")]) expect(attempt.text).not.toContain(secret);
      }
      await expectNothingChanged(before);
    });

  it("SEC-28 未認証は401、停止中は403で、何も返さない・変えない", async () => {
    const before = [await userRow(id("poc_s002"))];
    const body = { targets: await targetsOf([id("poc_s002")]), confirmed: true };
    for (const attempt of [await graduate(null, body), await candidates(null), await history(null)]) expect(attempt.status).toBe(401);
    const suspended = await graduate("poc_suspended", body);
    expect([suspended.status, suspended.body.error?.code]).toEqual([403, "ACCOUNT_SUSPENDED"]);
    await expectNothingChanged(before);
  });
});

describe("API-GR-01 変更候補", () => {
  it("既定では、発行済みの卒業予定の在校生だけを公開表示名の昇順で返す", async () => {
    await newUsers([
      { userId: "g-b", displayName: "い", department: "デザイン学科", graduationYear: 2028 },
      { userId: "g-a", displayName: "い" },
      { userId: "g-none", isGraduating: false }, { userId: "g-alumni", baseRole: "alumni" }, { userId: "g-staff", baseRole: "staff" },
      { userId: "g-pending", provisioningStatus: "pending" }, { userId: "g-unverified", eligibilityStatus: "pending" },
    ]);
    const found = await candidates("poc_school");
    expect(found.status).toBe(200);
    expect(found.body.meta.page?.totalCount).toBe(3);
    expect(found.body.data?.items?.map(({ userId }) => userId)).toEqual(["g-a", "g-b", id("poc_s002")]);
    expect(found.body.data?.items?.[1]).toEqual({
      userId: "g-b", displayName: "い", baseRole: "student", isGraduating: true,
      department: "デザイン学科", entryYear: null, graduationYear: 2028, version: 1,
    });
    const [identity] = await db.select().from(identityRecords).where(eq(identityRecords.userId, id("poc_s002")));
    for (const secret of [identity.privateRealName, identity.schoolReference, "本人だけの関心", "自己紹介"]) {
      expect(found.text).not.toContain(secret);
    }
  });

  it("修正では、在校生と卒業生だけを返し、学校職員を含めない", async () => {
    const found = await candidates("poc_school", "?mode=correction&limit=50");
    const returned = found.body.data!.items!.map(({ userId }) => userId);
    for (const username of ["poc_s001", "poc_s002", "poc_a001", "poc_s_mgr", "poc_a_mgr", "poc_suspended"]) expect(returned).toContain(id(username));
    for (const username of ["poc_school", "poc_staff", "poc_staff_mgr"]) expect(returned).not.toContain(id(username));
  });

  it("キーワード（公開表示名・利用者ID）、学科、卒業年度で絞り込み、件数にも同じ条件を使う", async () => {
    await newUsers([
      { userId: "g-1", displayName: "さくら100%", department: "デザイン学科", graduationYear: 2028 },
      { userId: "g-2", displayName: "さくら", department: "IT学科（架空）", graduationYear: 2028 },
    ]);
    const idsOf = async (query: string) => {
      const found = await candidates("poc_school", query);
      expect(found.status).toBe(200);
      const returned = found.body.data!.items!.map(({ userId }) => userId);
      expect(found.body.meta.page?.totalCount).toBe(returned.length);
      return returned;
    };
    expect(await idsOf(`?q=${encodeURIComponent("さくら")}`)).toEqual(["g-2", "g-1"]);
    expect(await idsOf(`?q=${encodeURIComponent("0%")}`)).toEqual(["g-1"]);
    expect(await idsOf("?q=g-2")).toEqual(["g-2"]);
    expect(await idsOf(`?department=${encodeURIComponent("デザイン学科")}`)).toEqual(["g-1"]);
    expect(await idsOf("?graduationYear=2028")).toEqual(["g-2", "g-1"]);
    expect(await idsOf(`?graduationYear=2028&q=${encodeURIComponent("%")}`)).toEqual(["g-1"]);
    // 本人のみの任意項目には一致しない。
    expect(await idsOf(`?q=${encodeURIComponent("本人だけ")}`)).toEqual([]);
    for (const query of ["?mode=x", "?q=", "?graduationYear=28", "?name=a", "?limit=51", "?mode=graduate&mode=graduate"]) {
      expect((await candidates("poc_school", query)).status, query).toBe(400);
    }
  });

  it("非表示中の利用者も候補にするが、審査前の表示名を返さず、検索・並び順にも使わない", async () => {
    await newUsers([
      { userId: "g-hidden-a", displayName: "あ審査前", profileState: "hidden" },
      { userId: "g-hidden-b", displayName: "い審査前", profileState: "hidden" },
      { userId: "g-public", displayName: "んん" },
    ]);
    const found = await candidates("poc_school");
    expect(found.body.data?.items?.map(({ userId, displayName }) => [userId, displayName])).toEqual([
      [id("poc_s002"), "みなと"], ["g-public", "んん"], ["g-hidden-a", null], ["g-hidden-b", null],
    ]);
    expect(found.text).not.toContain("審査前");
    const searched = await candidates("poc_school", `?q=${encodeURIComponent("審査前")}`);
    expect([searched.body.data?.items, searched.body.meta.page?.totalCount]).toEqual([[], 0]);
    expect((await candidates("poc_school", "?q=g-hidden-b")).body.data?.items).toMatchObject([{ userId: "g-hidden-b", displayName: null }]);
  });

  it("同じ表示名・非表示中の利用者を含めて、抜け・重複なくページ送りできる", async () => {
    await newUsers([
      ...["g-1", "g-2", "g-3"].map((userId) => ({ userId, displayName: "同名" })),
      ...["g-4", "g-5", "g-6"].map((userId) => ({ userId, displayName: "同名", profileState: "hidden" as const })),
    ]);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: Result = await candidates("poc_school", `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.body.meta.page?.totalCount).toBe(7);
      seen.push(...page.body.data!.items!.map(({ userId }) => userId));
      cursor = page.body.meta.page!.nextCursor;
    } while (cursor && seen.length < 20);
    // 「みなと」と「同名」の順は照合順序によるため、公開中の並びはDBの結果と比べ、非表示中は最後にID順で並ぶことを確認する。
    const publicIds = (await db.select({ userId: communityUsers.userId }).from(communityUsers)
      .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
      .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
      .where(and(eq(communityUsers.isGraduating, true), eq(communityUsers.profileState, "public")))
      .orderBy(asc(profileRevisions.displayName), asc(communityUsers.userId))).map(({ userId }) => userId);
    expect(publicIds).toHaveLength(4);
    expect(seen).toEqual([...publicIds, "g-4", "g-5", "g-6"]);
    const first = await candidates("poc_school", "?limit=2");
    const other = encodeURIComponent(first.body.meta.page!.nextCursor!);
    expect((await candidates("poc_school", `?limit=2&mode=correction&cursor=${other}`)).body.error?.code).toBe("INVALID_CURSOR");
  });
});

describe("API-GR-02 卒業生への一括変更", () => {
  it("AC-10 複数の卒業予定者を卒業生へ変更し、対象者ごとに変更前後・実行者・日時・バッチIDを履歴と監査に残す", async () => {
    const userIds = [...await newUsers([{ userId: "g-1" }, { userId: "g-2" }]), id("poc_s002")];
    const targets = await targetsOf(userIds);
    const applied = await graduate("poc_school", { targets, confirmed: true });
    expect(applied.status).toBe(201);
    const data = applied.body.data as { resource: { type: string; id: string }; version: null; state: string; affectedCount: number; committedAt: string };
    expect(data).toMatchObject({ resource: { type: "graduation_batch" }, version: null, state: "applied", affectedCount: 3 });

    const changes = await db.select().from(graduationChanges);
    expect(changes.map(({ userId }) => userId).sort()).toEqual([...userIds].sort());
    for (const change of changes) {
      expect(change).toMatchObject({
        batchId: data.resource.id, actorId: id("poc_school"), changeKind: "graduation",
        beforeRole: "student", afterRole: "alumni", beforeGraduating: true, afterGraduating: false,
      });
      expect(change.createdAt.toISOString()).toBe(data.committedAt);
    }
    const audits = await db.select().from(auditLogs);
    expect(audits).toHaveLength(3);
    for (const { userId, expectedVersion } of targets) {
      expect(await userRow(userId)).toMatchObject({ baseRole: "alumni", isGraduating: false, version: expectedVersion + 1 });
      expect(audits.find(({ targetId }) => targetId === userId)).toMatchObject({
        actorId: id("poc_school"), actionType: "graduation.graduated", targetType: "user", publicReason: null,
        beforeState: { baseRole: "student", isGraduating: true, version: expectedVersion, batchId: data.resource.id },
        afterState: { baseRole: "alumni", isGraduating: false, version: expectedVersion + 1, batchId: data.resource.id },
      });
    }
    // 通知の対象ではない。
    expect(await db.select().from(notifications)).toEqual([]);
    expect((await candidates("poc_school")).body.meta.page?.totalCount).toBe(0);
  });

  it("AC-11 利用者ID・投稿・プロフィール版・管理権限・停止・公開状態を維持する", async () => {
    await newUsers([
      { userId: "g-mgr", appManager: true }, { userId: "g-suspended", accountStatus: "suspended" }, { userId: "g-hidden", profileState: "hidden" },
    ]);
    const [category] = await db.select({ id: qaCategories.id }).from(qaCategories).limit(1);
    await db.insert(qaQuestions).values({ authorId: "g-mgr", authorLabel: "投稿時の表示名", categoryId: category.id, title: "質問", bodyMarkdown: "本文" });
    const snapshot = async () => ({
      questions: await db.select().from(qaQuestions).where(eq(qaQuestions.authorId, "g-mgr")),
      revisions: await db.select().from(profileRevisions).where(like(profileRevisions.userId, "g-%")).orderBy(asc(profileRevisions.userId)),
      profiles: await db.select().from(profiles).where(like(profiles.userId, "g-%")).orderBy(asc(profiles.userId)),
      users: (await db.select().from(communityUsers).where(like(communityUsers.userId, "g-%")).orderBy(asc(communityUsers.userId)))
        .map(({ baseRole, isGraduating, version, ...kept }) => { void baseRole; void isGraduating; void version; return kept; }),
    });
    const before = await snapshot();
    expect((await graduate("poc_school", {
      targets: await targetsOf(["g-mgr", "g-suspended", "g-hidden"]), confirmed: true,
    })).status).toBe(201);
    expect(await snapshot()).toEqual(before);
    expect(await userRow("g-mgr")).toMatchObject({ baseRole: "alumni", appManager: true });
  });

  it("変更後は卒業生として卒業生検索に載る（掲載希望・公開中の条件は変えない）", async () => {
    await newUsers([{ userId: "g-1", displayName: "けんさく対象" }]);
    expect((await graduate("poc_school", { targets: await targetsOf(["g-1"]), confirmed: true })).status).toBe(201);
    const found = await result(await alumniRoute.GET(new Request(`${origin}/api/v1/alumni?q=${encodeURIComponent("けんさく対象")}`, {
      headers: { Cookie: await logIn("poc_s001") },
    }), {}));
    expect(found.body.data?.items).toMatchObject([{ userId: "g-1", baseRole: "alumni", isGraduating: false }]);
  });

  const invalidMember: Array<[string, () => Promise<{ userId: string; expectedVersion: number }>, number, string]> = [
    ["版番号が古い", async () => ({ userId: "g-2", expectedVersion: 2 }), 409, "VERSION_CONFLICT"],
    ["卒業予定でない在校生", async () => (await targetsOf(await newUsers([{ userId: "g-x", isGraduating: false }])))[0], 409, "STATE_CONFLICT"],
    ["既に卒業生", async () => (await targetsOf([id("poc_a001")]))[0], 409, "STATE_CONFLICT"],
    ["学校職員", async () => (await targetsOf([id("poc_staff")]))[0], 409, "STATE_CONFLICT"],
    ["存在しない", async () => ({ userId: "no-such-user", expectedVersion: 1 }), 404, "NOT_FOUND"],
    ["発行準備中", async () => (await targetsOf(await newUsers([{ userId: "g-x", provisioningStatus: "pending" }])))[0], 404, "NOT_FOUND"],
  ];
  it.each(invalidMember)("AC-11 対象に「%s」利用者が1人でもいれば、誰も変更しない", async (_label, member, status, code) => {
    await newUsers([{ userId: "g-1" }, { userId: "g-2" }, { userId: "g-3" }]);
    const invalid = await member();
    const before = [await userRow("g-1"), await userRow("g-2"), await userRow("g-3")];
    const valid = (await targetsOf(["g-1", "g-2", "g-3"])).filter(({ userId }) => userId !== invalid.userId);
    // 不正な対象の位置によらない（先頭・途中・末尾）。
    for (const position of [0, 1, valid.length]) {
      const failed = await graduate("poc_school", { targets: valid.toSpliced(position, 0, invalid), confirmed: true });
      expect([failed.status, failed.body.error?.code]).toEqual([status, code]);
    }
    await expectNothingChanged(before);
  });

  it.each(["graduation_changes", "audit_logs", "operation_receipts"])("AC-11 %s の記録に失敗したら、すべて取り消す", async (table) => {
    await newUsers([{ userId: "g-1" }, { userId: "g-2" }]);
    const before = [await userRow("g-1"), await userRow("g-2")];
    // 履歴と監査は2人目の記録だけを失敗させ、1人目の分も残らないことを確認する。
    const condition = { graduation_changes: "user_id <> 'g-2'", audit_logs: "target_id <> 'g-2'", operation_receipts: "result_type <> 'graduation_batch'" }[table];
    await db.execute(`ALTER TABLE ${table} ADD CONSTRAINT reject_for_test CHECK (${condition})`);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await graduate("poc_school", { targets: await targetsOf(["g-1", "g-2"]), confirmed: true })).status).toBe(500);
    } finally {
      logged.mockRestore();
      await db.execute(`ALTER TABLE ${table} DROP CONSTRAINT reject_for_test`);
    }
    await expectNothingChanged(before);
  });

  it("人数・重複・最終確認・未定義の項目を検証し、422では何も変えない", async () => {
    await newUsers([{ userId: "g-1" }]);
    const before = [await userRow("g-1")];
    const one = { userId: "g-1", expectedVersion: 1 };
    const many = Array.from({ length: 101 }, (_, index) => ({ userId: `g-many-${index}`, expectedVersion: 1 }));
    const cases: Array<[unknown, string]> = [
      [{ targets: [], confirmed: true }, "targets"],
      [{ targets: many, confirmed: true }, "targets"],
      [{ targets: [one, one], confirmed: true }, "targets"],
      [{ targets: [one, { ...one, expectedVersion: 2 }], confirmed: true }, "targets"],
      [{ targets: [one] }, "confirmed"],
      [{ targets: [one], confirmed: false }, "confirmed"],
      [{ targets: [{ userId: "g-1" }], confirmed: true }, "targets.0.expectedVersion"],
      [{ targets: [{ ...one, baseRole: "alumni" }], confirmed: true }, "targets.0"],
      [{ targets: [one], confirmed: true, actorId: "g-1" }, ""],
    ];
    for (const [body, path] of cases) {
      const rejected = await graduate("poc_school", body);
      expect(rejected.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(rejected.body.error?.fields?.map((field) => field.path)).toEqual([path]);
    }
    await expectNothingChanged(before);
  });

  it("100人を1回で変更でき、対象者ごとの問い合わせを増やさない", async () => {
    const batch = async (userIds: string[]) => {
      const targets = await targetsOf(userIds);
      queries.length = 0;
      const applied = await graduate("poc_school", { targets, confirmed: true });
      expect([applied.status, applied.body.data?.affectedCount]).toEqual([201, userIds.length]);
      return queries.length;
    };
    const small = await batch(await newUsers([{ userId: "g-a" }, { userId: "g-b" }]));
    const userIds = await newUsers(Array.from({ length: 100 }, (_, index) => ({ userId: `g-${String(index).padStart(3, "0")}` })));
    expect(await batch(userIds)).toBe(small);
    const rows = await db.select({ baseRole: communityUsers.baseRole }).from(communityUsers).where(inArray(communityUsers.userId, userIds));
    expect(rows.filter(({ baseRole }) => baseRole === "alumni")).toHaveLength(100);
    expect(await db.select().from(auditLogs)).toHaveLength(102);
  });

  it("同じ再送キーの再送は同じ結果を返し、履歴・監査を重複させない。別の内容には使えない", async () => {
    await newUsers([{ userId: "g-1" }, { userId: "g-2" }]);
    const key = `retry-${randomUUID()}`;
    const body = { targets: await targetsOf(["g-1", "g-2"]), confirmed: true };
    const first = await graduate("poc_school", body, key);
    const again = await graduate("poc_school", body, key);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.data).toEqual(first.body.data);
    expect(again.body.meta.replayed).toBe(true);
    expect(await db.select().from(graduationChanges)).toHaveLength(2);
    expect(await db.select().from(auditLogs)).toHaveLength(2);
    const reused = await graduate("poc_school", { ...body, targets: body.targets.slice(0, 1) }, key);
    expect(reused.body.error?.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // 再送時も、実行者の現在の権限で判定する。
    await db.update(communityUsers).set({ schoolManager: false }).where(eq(communityUsers.userId, id("poc_school")));
    try {
      expect((await graduate("poc_school", body, key)).status).toBe(403);
    } finally {
      await db.update(communityUsers).set({ schoolManager: true }).where(eq(communityUsers.userId, id("poc_school")));
    }
  });

  it("別々の学校管理者が、重なる対象を逆順で同時に変更しても、デッドロックせず1件だけが確定する", async () => {
    const userIds = await newUsers(Array.from({ length: 10 }, (_, index) => ({ userId: `g-${index}` })));
    const targets = await targetsOf(userIds);
    // 同じ実行者の操作は実行者の行ロックで順番に処理されるため、別の学校管理者（学校職員に権限を付けたもの）を使う。
    const actors = ["poc_school", "poc_staff", "poc_staff_mgr"];
    await db.update(communityUsers).set({ schoolManager: true }).where(inArray(communityUsers.userId, actors.map(id)));
    for (const actor of actors) await logIn(actor);
    const results = await Promise.all([
      graduate(actors[0], { targets, confirmed: true }),
      graduate(actors[1], { targets: [...targets].reverse(), confirmed: true }),
      graduate(actors[2], { targets: targets.slice(5), confirmed: true }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([201, 409, 409]);
    const changes = await db.select().from(graduationChanges);
    expect(new Set(changes.map(({ batchId }) => batchId)).size).toBe(1);
    expect(changes).toHaveLength(Number(results.find(({ status }) => status === 201)!.body.data!.affectedCount));
  });

  it.each(["一括変更", "修正"])("処理中の対象者の変更が確定するのを待ち、確定後の状態で判定する（%s）", async (kind) => {
    await newUsers([{ userId: "g-1" }, { userId: "g-2" }]);
    await logIn("poc_school");
    const client = await pool.connect();
    let pending: Promise<Result> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE community_users SET is_graduating = false, version = version + 1 WHERE user_id = 'g-2'");
      pending = kind === "一括変更"
        ? graduate("poc_school", { targets: ["g-1", "g-2"].map((userId) => ({ userId, expectedVersion: 1 })), confirmed: true })
        : correct("poc_school", { userId: "g-2", expectedVersion: 1, baseRole: "alumni", isGraduating: false, confirmed: true });
      await vi.waitFor(async () => {
        const { rows } = await target.client.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
        );
        expect(rows.length).toBeGreaterThan(0);
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pending?.catch(() => {});
    }
    const decided = await pending;
    expect([decided.status, decided.body.error?.code]).toEqual([409, "VERSION_CONFLICT"]);
    expect(await userRow("g-1")).toMatchObject({ baseRole: "student", isGraduating: true, version: 1 });
    expect(await userRow("g-2")).toMatchObject({ baseRole: "student", isGraduating: false, version: 2 });
    expect(await db.select().from(graduationChanges)).toEqual([]);
  });

  it("変更前の所属を、プロフィールとアカウントの証拠として保全する", async () => {
    await newUsers([{ userId: "g-1", displayName: "対象者" }, { userId: "g-2" }]);
    for (const kind of ["profile", "account"] as const) {
      const [reportTarget] = await db.insert(reportTargets).values({ kind, subjectUserId: "g-1" }).returning({ id: reportTargets.id });
      await db.insert(reportCases).values({ targetId: reportTarget.id, assigneeId: id("poc_school") });
    }
    expect((await graduate("poc_school", { targets: await targetsOf(["g-1", "g-2"]), confirmed: true })).status).toBe(201);
    const evidence = await db.select({ kind: reportTargets.kind, snapshot: evidenceSnapshots.snapshot }).from(evidenceSnapshots)
      .innerJoin(reportTargets, eq(reportTargets.id, evidenceSnapshots.targetId)).orderBy(asc(reportTargets.kind));
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ kind: "account", snapshot: { baseRole: "student", displayName: "対象者" } });
    expect(evidence[1]).toMatchObject({ kind: "profile", snapshot: { baseRole: "student", isGraduating: true } });
    expect(JSON.stringify(evidence)).not.toContain("本人だけの関心");
  });
});

describe("API-GR-03 誤変更の修正", () => {
  const correction = async (userId: string, baseRole: string, isGraduating: boolean) => ({
    userId, expectedVersion: (await userRow(userId)).version, baseRole, isGraduating, confirmed: true,
  });

  it.each([
    ["alumni", false, "student", true], ["alumni", false, "student", false], ["student", false, "student", true],
    ["student", true, "student", false], ["student", false, "alumni", false], ["student", true, "alumni", false],
  ] as const)("AC-10 %s（卒業予定=%s）を %s（卒業予定=%s）へ修正し、変更前後を履歴と監査に残す", async (beforeRole, beforeGraduating, afterRole, afterGraduating) => {
    await newUsers([{ userId: "g-1", baseRole: beforeRole, isGraduating: beforeGraduating, appManager: true }]);
    const corrected = await correct("poc_school", await correction("g-1", afterRole, afterGraduating));
    expect(corrected.status).toBe(201);
    const data = corrected.body.data as { resource: { id: string } };
    expect(corrected.body.data).toMatchObject({ resource: { type: "graduation_batch" }, version: null, state: "corrected", affectedCount: 1 });
    expect(await userRow("g-1")).toMatchObject({ baseRole: afterRole, isGraduating: afterGraduating, version: 2, appManager: true });
    expect(await db.select().from(graduationChanges)).toMatchObject([{
      batchId: data.resource.id, userId: "g-1", actorId: id("poc_school"), changeKind: "correction",
      beforeRole, beforeGraduating, afterRole, afterGraduating,
    }]);
    expect(await db.select().from(auditLogs)).toMatchObject([{
      actionType: "graduation.corrected", targetId: "g-1",
      beforeState: { baseRole: beforeRole, isGraduating: beforeGraduating, version: 1, batchId: data.resource.id },
      afterState: { baseRole: afterRole, isGraduating: afterGraduating, version: 2, batchId: data.resource.id },
    }]);
  });

  it("AC-10 一括変更した利用者を元の区分へ修正でき、両方の履歴が残る", async () => {
    await newUsers([{ userId: "g-1" }]);
    expect((await graduate("poc_school", { targets: await targetsOf(["g-1"]), confirmed: true })).status).toBe(201);
    expect((await correct("poc_school", await correction("g-1", "student", true))).status).toBe(201);
    expect(await userRow("g-1")).toMatchObject({ baseRole: "student", isGraduating: true, version: 3 });
    const found = await history("poc_school", "?userId=g-1");
    expect(found.body.data?.items?.map(({ changeKind, before, after }) => [changeKind, before, after])).toEqual([
      ["correction", { baseRole: "alumni", isGraduating: false }, { baseRole: "student", isGraduating: true }],
      ["graduation", { baseRole: "student", isGraduating: true }, { baseRole: "alumni", isGraduating: false }],
    ]);
    // 修正後は、再び一括変更の候補になる。
    expect((await candidates("poc_school", "?q=g-1")).body.meta.page?.totalCount).toBe(1);
  });

  it("卒業生の卒業予定・所属の指定誤り・最終確認なしは422、学校職員・同じ区分・古い版は409、存在しない利用者は404", async () => {
    await newUsers([{ userId: "g-1" }, { userId: "g-staff", baseRole: "staff" }]);
    const before = [await userRow("g-1"), await userRow("g-staff")];
    const base = await correction("g-1", "student", false);
    const cases: Array<[unknown, number, string, string?]> = [
      [{ ...base, baseRole: "alumni", isGraduating: true }, 422, "VALIDATION_FAILED", "isGraduating"],
      [{ ...base, baseRole: "staff" }, 422, "VALIDATION_FAILED", "baseRole"],
      [{ ...base, isGraduating: "true" }, 422, "VALIDATION_FAILED", "isGraduating"],
      [{ ...base, confirmed: false }, 422, "VALIDATION_FAILED", "confirmed"],
      [{ ...base, appManager: true }, 422, "VALIDATION_FAILED", ""],
      [{ ...base, expectedVersion: 2 }, 409, "VERSION_CONFLICT"],
      [await correction("g-1", "student", true), 409, "STATE_CONFLICT"],
      [await correction("g-staff", "alumni", false), 409, "STATE_CONFLICT"],
      [{ ...base, userId: "no-such-user" }, 404, "NOT_FOUND"],
    ];
    for (const [body, status, code, path] of cases) {
      const rejected = await correct("poc_school", body);
      expect([rejected.status, rejected.body.error?.code], JSON.stringify(body)).toEqual([status, code]);
      if (path !== undefined) expect(rejected.body.error?.fields?.map((field) => field.path)).toEqual([path]);
    }
    await expectNothingChanged(before);
  });

  it("一括変更と修正が同時でも、一方だけが確定する。再送は履歴・監査を重複させない", async () => {
    await newUsers([{ userId: "g-1" }]);
    await logIn("poc_school");
    const key = `retry-${randomUUID()}`;
    const body = await correction("g-1", "student", false);
    const [applied, corrected] = await Promise.all([
      graduate("poc_school", { targets: [{ userId: "g-1", expectedVersion: 1 }], confirmed: true }),
      correct("poc_school", body, key),
    ]);
    expect([applied.status, corrected.status].sort()).toEqual([201, 409]);
    expect(await db.select().from(graduationChanges)).toHaveLength(1);
    const again = await correct("poc_school", body, key);
    expect(again.status).toBe(corrected.status);
    expect(await db.select().from(graduationChanges)).toHaveLength(1);
    expect(await db.select().from(auditLogs)).toHaveLength(1);
  });
});

describe("API-GR-04 変更履歴", () => {
  it("新しい順に返し、利用者・バッチで絞り込める。DTOにない項目を返さない", async () => {
    await newUsers([{ userId: "g-1", displayName: "いち" }, { userId: "g-2" }]);
    const first = await graduate("poc_school", { targets: await targetsOf(["g-1", "g-2"]), confirmed: true });
    const batchId = (first.body.data as { resource: { id: string } }).resource.id;
    const { version } = await userRow("g-1");
    expect((await correct("poc_school", { userId: "g-1", expectedVersion: version, baseRole: "student", isGraduating: false, confirmed: true })).status).toBe(201);

    const all = await history("poc_school");
    expect(all.body.meta.page?.totalCount).toBe(3);
    expect(all.body.data?.items?.[0]).toEqual({
      id: expect.any(String), batchId: expect.any(String), userId: "g-1",
      actor: { userId: id("poc_school"), displayName: "学校管理者（サンプル）" }, changeKind: "correction",
      before: { baseRole: "alumni", isGraduating: false }, after: { baseRole: "student", isGraduating: false },
      createdAt: expect.stringMatching(/Z$/),
    });
    const byBatch = await history("poc_school", `?batchId=${batchId.toUpperCase()}`);
    expect(byBatch.body.data?.items?.map(({ userId }) => userId).sort()).toEqual(["g-1", "g-2"]);
    expect(byBatch.body.meta.page?.totalCount).toBe(2);
    expect((await history("poc_school", "?userId=g-2")).body.meta.page?.totalCount).toBe(1);
    expect((await history("poc_school", `?userId=g-2&batchId=${randomUUID()}`)).body.meta.page?.totalCount).toBe(0);
    for (const query of ["?batchId=x", "?userId=", "?userId=g-1&userId=g-2", "?actorId=g-1", "?limit=0"]) {
      expect((await history("poc_school", query)).status, query).toBe(400);
    }
  });

  it("同じ時刻の変更も、抜け・重複なくページ送りできる", async () => {
    const userIds = await newUsers(Array.from({ length: 5 }, (_, index) => ({ userId: `g-${index}` })));
    expect((await graduate("poc_school", { targets: await targetsOf(userIds), confirmed: true })).status).toBe(201);
    // 同じミリ秒の中のマイクロ秒の差も含める。
    for (const userId of ["g-1", "g-3"]) {
      await target.client.query("UPDATE graduation_changes SET created_at = created_at + interval '100 microseconds' WHERE user_id = $1", [userId]);
    }
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: Result = await history("poc_school", `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...page.body.data!.items!.map((item) => item.id));
      cursor = page.body.meta.page!.nextCursor;
    } while (cursor && seen.length < 20);
    const expected = await db.select({ id: graduationChanges.id }).from(graduationChanges)
      .orderBy(desc(graduationChanges.createdAt), desc(graduationChanges.id));
    expect(seen).toEqual(expected.map((row) => row.id));
    const first = encodeURIComponent((await history("poc_school", "?limit=2")).body.meta.page!.nextCursor!);
    expect((await history("poc_school", `?limit=2&userId=g-1&cursor=${first}`)).body.error?.code).toBe("INVALID_CURSOR");
  });

  it("画面の履歴に、非表示中の対象者の審査前の表示名を返さない", async () => {
    await newUsers([{ userId: "g-1", displayName: "審査前", profileState: "hidden" }]);
    expect((await graduate("poc_school", { targets: await targetsOf(["g-1"]), confirmed: true })).status).toBe(201);
    const { listGraduationChanges, parseGraduationChangeQuery } = await import("../../src/admin/graduation");
    const viewer = {
      userId: id("poc_school"), baseRole: "staff" as const, isGraduating: false, profileState: "public" as const, userVersion: 1,
      roles: { schoolManager: true, appManager: false },
    };
    const { data } = await listGraduationChanges(db, viewer, parseGraduationChangeQuery(new URL("http://app/")));
    expect(data.items).toMatchObject([{ displayName: null, change: { userId: "g-1" } }]);
    const [row] = await db.select().from(graduationChanges).where(and(eq(graduationChanges.userId, "g-1")));
    expect(data.items[0].change.id).toBe(row.id);
  });
});
