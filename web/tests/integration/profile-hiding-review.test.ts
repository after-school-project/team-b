import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
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
import type { Viewer } from "../../src/auth/access";

/**
 * プロフィールの非表示（API-US-05）と再公開審査（API-PR-01〜03）。実際の Route Handler を実セッションで呼ぶ（#8 ⑤）。
 * AC-04：再公開審査に `self` の任意項目を含めない。
 * AC-07：権限内の管理者が理由付きで非表示にでき、アプリ管理者対象は学校管理者だけが操作できる。
 * AC-08：古い審査版は承認・却下できない。
 * AC-09：承認で公開、却下で非表示と理由が維持される。
 */

const { communityUsers, identityRecords, profileReviews, profileRevisions, profiles, qaCategories } = community;
const { qaQuestions, qaResponses } = content;
const {
  auditLogs, evidenceSnapshots, notifications, operationReceipts, reportActions, reportCaseEvidence, reportCases, reportTargets,
  reports,
} = moderation;
const schema = { ...auth, ...content, ...community, ...moderation };
const origin = "https://school.example";
const reason = "公開表示名に個人情報が含まれています。";

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let credentialsDir: string;
let credentials: Record<string, string>;
let hidingRoute: typeof import("../../src/app/api/v1/admin/users/[userId]/profile-hiding/route");
let listRoute: typeof import("../../src/app/api/v1/admin/profile-reviews/route");
let detailRoute: typeof import("../../src/app/api/v1/admin/profile-reviews/[reviewId]/route");
let decisionRoute: typeof import("../../src/app/api/v1/admin/profile-reviews/[reviewId]/decision/route");
let profileRoute: typeof import("../../src/app/api/v1/me/profile/route");
const ids = new Map<string, string>();
const cookies = new Map<string, string>();

vi.mock("server-only", () => ({}));
vi.mock("../../src/db/client", () => ({ db: drizzle(pool, { schema }) }));

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 8 });
  db = drizzle(pool, { schema });
  credentialsDir = await mkdtemp(join(tmpdir(), "team-b-profile-hiding-test-"));
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  await seedDevelopmentData(drizzle(target.client), credentialsDir);
  credentials = JSON.parse(await readFile(join(credentialsDir, "accounts.json"), "utf8"));
  for (const row of await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user)) {
    if (row.username) ids.set(row.username, row.id);
  }
  hidingRoute = await import("../../src/app/api/v1/admin/users/[userId]/profile-hiding/route");
  listRoute = await import("../../src/app/api/v1/admin/profile-reviews/route");
  detailRoute = await import("../../src/app/api/v1/admin/profile-reviews/[reviewId]/route");
  decisionRoute = await import("../../src/app/api/v1/admin/profile-reviews/[reviewId]/decision/route");
  profileRoute = await import("../../src/app/api/v1/me/profile/route");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await endPool(pool);
  if (credentialsDir) await rm(credentialsDir, { recursive: true, force: true });
  await target?.dispose();
});

// 各テストを同じ状態から始める（利用者は seed のものを使い、前のテストの記録・権限・公開状態を戻す）。
beforeEach(async () => {
  for (const table of [
    reports, reportCaseEvidence, evidenceSnapshots, reportActions, reportCases, reportTargets, notifications, auditLogs,
    operationReceipts, profileReviews,
  ]) await db.delete(table);
  await db.update(communityUsers).set({ profileState: "public", appManager: false });
  for (const username of ["poc_s_mgr", "poc_a_mgr", "poc_staff_mgr"]) {
    await db.update(communityUsers).set({ appManager: true }).where(eq(communityUsers.userId, id(username)));
  }
  for (const first of await db.select().from(profileRevisions).where(eq(profileRevisions.revisionNo, 1))) {
    await db.update(profiles).set({ currentRevisionId: first.id }).where(eq(profiles.userId, first.userId));
  }
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
  meta: { replayed?: boolean; page?: { totalCount: number; nextCursor: string | null; hasMore: boolean } };
};
type Result = { status: number; body: Body; text: string };

async function result(response: Response): Promise<Result> {
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Body, text };
}

async function headersFor(username: string | null, key?: string): Promise<HeadersInit> {
  return {
    ...username ? { Cookie: await logIn(username) } : {},
    ...key ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key } : {},
  };
}

async function hide(username: string | null, userId: string, body: unknown, key = `hide-${randomUUID()}`): Promise<Result> {
  return result(await hidingRoute.POST(new Request(`${origin}/api/v1/admin/users/${userId}/profile-hiding`, {
    method: "POST", headers: await headersFor(username, key), body: JSON.stringify(body),
  }), { params: Promise.resolve({ userId }) }));
}

async function list(username: string | null, query = ""): Promise<Result> {
  return result(await listRoute.GET(new Request(`${origin}/api/v1/admin/profile-reviews${query}`, {
    headers: await headersFor(username),
  }), {}));
}

async function detail(username: string | null, reviewId: string): Promise<Result> {
  return result(await detailRoute.GET(new Request(`${origin}/api/v1/admin/profile-reviews/${reviewId}`, {
    headers: await headersFor(username),
  }), { params: Promise.resolve({ reviewId }) }));
}

async function decide(username: string | null, reviewId: string, body: unknown, key = `decide-${randomUUID()}`): Promise<Result> {
  return result(await decisionRoute.POST(new Request(`${origin}/api/v1/admin/profile-reviews/${reviewId}/decision`, {
    method: "POST", headers: await headersFor(username, key), body: JSON.stringify(body),
  }), { params: Promise.resolve({ reviewId }) }));
}

async function saveProfile(username: string, body: unknown): Promise<Result> {
  return result(await profileRoute.PATCH(new Request(`${origin}/api/v1/me/profile`, {
    method: "PATCH", headers: await headersFor(username, `save-${randomUUID()}`), body: JSON.stringify(body),
  }), {}));
}

async function userRow(username: string) {
  const [row] = await db.select({
    version: communityUsers.version, profileState: communityUsers.profileState, accountStatus: communityUsers.accountStatus,
    profileVersion: profiles.version, currentRevisionId: profiles.currentRevisionId,
  }).from(communityUsers).innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .where(eq(communityUsers.userId, id(username)));
  return row;
}

async function reviewRow(reviewId: string) {
  const [row] = await db.select().from(profileReviews).where(eq(profileReviews.id, reviewId));
  return row;
}

const notificationsOf = (username: string) => db.select().from(notifications)
  .where(eq(notifications.recipientId, id(username))).orderBy(asc(notifications.createdAt));
const audits = () => db.select().from(auditLogs).orderBy(asc(auditLogs.createdAt));

/** 再公開申請を作る（本人の現在版を対象にする）。 */
async function newReview(username: string, submittedAt = new Date()): Promise<string> {
  await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, id(username)));
  const [row] = await db.insert(profileReviews).values({
    userId: id(username), revisionId: (await userRow(username)).currentRevisionId, submittedAt,
  }).returning({ id: profileReviews.id });
  return row.id;
}

type CaseTarget = { kind: "profile" | "account"; userId: string } | { kind: "question"; questionId: string }
  | { kind: "response"; responseId: string };

async function newCase(caseTarget: CaseTarget, options: {
  status?: "unhandled" | "in_progress" | "closed"; assignee?: string | null; schoolOnly?: boolean; closedAt?: Date;
} = {}): Promise<string> {
  const { status = "in_progress", assignee = "poc_school", schoolOnly = false } = options;
  const values = caseTarget.kind === "question" ? { kind: caseTarget.kind, questionId: caseTarget.questionId }
    : caseTarget.kind === "response" ? { kind: caseTarget.kind, responseId: caseTarget.responseId }
      : { kind: caseTarget.kind, subjectUserId: caseTarget.userId };
  await db.insert(reportTargets).values(values).onConflictDoNothing();
  const condition = caseTarget.kind === "question" ? eq(reportTargets.questionId, caseTarget.questionId)
    : caseTarget.kind === "response" ? eq(reportTargets.responseId, caseTarget.responseId)
      : and(eq(reportTargets.kind, caseTarget.kind), eq(reportTargets.subjectUserId, caseTarget.userId));
  const [reportTarget] = await db.select({ id: reportTargets.id }).from(reportTargets).where(condition);
  const [row] = await db.insert(reportCases).values({
    targetId: reportTarget.id, status, schoolOnly, assigneeId: assignee === null ? null : id(assignee),
    handoffPending: assignee === null, closedAt: status === "closed" ? options.closedAt ?? new Date() : null,
  }).returning({ id: reportCases.id });
  return row.id;
}

async function caseRow(caseId: string) {
  const [row] = await db.select().from(reportCases).where(eq(reportCases.id, caseId));
  return row;
}

async function newQuestion(author: string): Promise<string> {
  const [category] = await db.select({ id: qaCategories.id }).from(qaCategories).limit(1);
  const [row] = await db.insert(qaQuestions).values({
    authorId: id(author), authorLabel: author, categoryId: category.id, title: "質問", bodyMarkdown: "本文",
  }).returning({ id: qaQuestions.id });
  return row.id;
}

async function newAnswer(author: string): Promise<string> {
  const [row] = await db.insert(qaResponses).values({
    questionId: await newQuestion("poc_s001"), authorId: id(author), authorLabel: author, kind: "answer", bodyMarkdown: "回答",
  }).returning({ id: qaResponses.id });
  return row.id;
}

/** 操作が何も変えず、記録も残していないこと。 */
async function expectUnchanged(username: string, before: Awaited<ReturnType<typeof userRow>>) {
  expect(await userRow(username)).toEqual(before);
  expect(await notificationsOf(username)).toEqual([]);
  expect(await audits()).toEqual([]);
}

describe("API-US-05 プロフィールの非表示", () => {
  it.each(["poc_school", "poc_s_mgr"])("AC-07 %s が一般の利用者を理由付きで非表示にでき、通知と監査を同時に記録する", async (actor) => {
    const before = await userRow("poc_s001");
    const hidden = await hide(actor, id("poc_s001"), { expectedVersion: before.version, reason });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toMatchObject({
      resource: { type: "user", id: id("poc_s001") }, version: before.version + 1, state: "hidden",
    });
    expect(await userRow("poc_s001")).toEqual({
      ...before, version: before.version + 1, profileState: "hidden", profileVersion: before.profileVersion + 1,
    });

    const [audit, ...others] = await audits();
    expect(others).toEqual([]);
    expect(audit).toMatchObject({
      actorId: id(actor), systemAction: false, actionType: "profile.hidden", targetType: "user", targetId: id("poc_s001"),
      beforeState: { profileState: "public" }, afterState: { profileState: "hidden" }, publicReason: reason,
    });
    const [notice, ...extra] = await notificationsOf("poc_s001");
    expect(extra).toEqual([]);
    expect(notice).toMatchObject({
      kind: "profile_hidden", profileUserId: id("poc_s001"),
      eventKey: `profile_hidden:${id("poc_s001")}:${audit.id}`,
      publicMessage: `プロフィールが管理者により非表示になりました。\n理由：${reason}`,
    });
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("AC-07 アプリ管理者を対象にした操作は、アプリ管理者（本人を含む）には403、学校管理者だけが行える", async () => {
    const before = await userRow("poc_a_mgr");
    for (const actor of ["poc_s_mgr", "poc_a_mgr"]) {
      const denied = await hide(actor, id("poc_a_mgr"), { expectedVersion: before.version, reason });
      expect([denied.status, denied.body.error?.code], actor).toEqual([403, "FORBIDDEN"]);
    }
    // 権限がない対象では、古い版番号でも409を返さず、対象の状態を明かさない。
    expect((await hide("poc_s_mgr", id("poc_a_mgr"), { expectedVersion: before.version + 5, reason })).status).toBe(403);
    await expectUnchanged("poc_a_mgr", before);
    expect((await hide("poc_school", id("poc_a_mgr"), { expectedVersion: before.version, reason })).status).toBe(200);
    expect((await userRow("poc_a_mgr")).profileState).toBe("hidden");
  });

  it("学校管理者は、どの管理者からも非表示にできない", async () => {
    const before = await userRow("poc_school");
    for (const actor of ["poc_school", "poc_s_mgr"]) {
      expect((await hide(actor, id("poc_school"), { expectedVersion: before.version, reason })).status).toBe(403);
    }
    await expectUnchanged("poc_school", before);
  });

  it("一般の利用者・非表示中や権限解除後のアプリ管理者は403、未認証は401、存在しない利用者は404", async () => {
    const before = await userRow("poc_s001");
    const body = { expectedVersion: before.version, reason };
    await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, id("poc_a_mgr")));
    await db.update(communityUsers).set({ appManager: false }).where(eq(communityUsers.userId, id("poc_staff_mgr")));
    for (const actor of ["poc_s002", "poc_staff", "poc_a_mgr", "poc_staff_mgr"]) {
      const denied = await hide(actor, id("poc_s001"), body);
      expect([denied.status, denied.body.error?.code], actor).toEqual([403, "FORBIDDEN"]);
      expect(denied.text).not.toContain("はる");
    }
    expect((await hide(null, id("poc_s001"), body)).status).toBe(401);
    expect((await hide("poc_school", "no-such-user", body)).status).toBe(404);
    await expectUnchanged("poc_s001", before);
  });

  it("停止中の利用者も非表示にでき、停止は解除しない", async () => {
    const before = await userRow("poc_suspended");
    expect((await hide("poc_s_mgr", id("poc_suspended"), { expectedVersion: before.version, reason })).status).toBe(200);
    expect(await userRow("poc_suspended")).toMatchObject({ profileState: "hidden", accountStatus: "suspended" });
  });

  it("古い版番号と、既に非表示の利用者は409、理由なし・未定義の項目は422で、何も変えない", async () => {
    const before = await userRow("poc_s001");
    const stale = await hide("poc_school", id("poc_s001"), { expectedVersion: before.version + 1, reason });
    expect([stale.status, stale.body.error?.code]).toEqual([409, "VERSION_CONFLICT"]);
    const invalid: Array<[unknown, string]> = [
      [{ expectedVersion: before.version }, "reason"],
      [{ expectedVersion: before.version, reason: " \n　" }, "reason"],
      [{ expectedVersion: before.version, reason: "あ".repeat(1001) }, "reason"],
      [{ expectedVersion: before.version, reason, sourceCaseId: "x" }, "sourceCaseId"],
      [{ expectedVersion: before.version, reason, actorId: id("poc_school") }, ""],
    ];
    for (const [body, path] of invalid) {
      const rejected = await hide("poc_school", id("poc_s001"), body);
      expect(rejected.status).toBe(422);
      expect(rejected.body.error?.fields?.map((field) => field.path)).toEqual([path]);
    }
    await expectUnchanged("poc_s001", before);

    expect((await hide("poc_school", id("poc_s001"), { expectedVersion: before.version, reason })).status).toBe(200);
    const again = await hide("poc_school", id("poc_s001"), { expectedVersion: before.version + 1, reason });
    expect([again.status, again.body.error?.code]).toEqual([409, "STATE_CONFLICT"]);
    expect(await notificationsOf("poc_s001")).toHaveLength(1);
  });

  it("同じ再送キーの再送は同じ結果を返し、通知と監査を重複させない。再送時も現在の権限で判定する", async () => {
    const { version } = await userRow("poc_s001");
    const key = `retry-${randomUUID()}`;
    const body = { expectedVersion: version, reason };
    const first = await hide("poc_s_mgr", id("poc_s001"), body, key);
    const again = await hide("poc_s_mgr", id("poc_s001"), body, key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body.data).toEqual(first.body.data);
    expect(again.body.meta.replayed).toBe(true);
    expect(await audits()).toHaveLength(1);
    expect(await notificationsOf("poc_s001")).toHaveLength(1);

    // 対象者がアプリ管理者になった後は、アプリ管理者による再送の結果も返さない。
    await db.update(communityUsers).set({ appManager: true }).where(eq(communityUsers.userId, id("poc_s001")));
    expect((await hide("poc_s_mgr", id("poc_s001"), body, key)).status).toBe(403);
  });

  it("複数の管理者が同時に非表示にしても、1人だけが確定する", async () => {
    const { version } = await userRow("poc_s001");
    for (const actor of ["poc_school", "poc_s_mgr", "poc_staff_mgr"]) await logIn(actor);
    const results = await Promise.all(["poc_school", "poc_s_mgr", "poc_staff_mgr"].map((actor) =>
      hide(actor, id("poc_s001"), { expectedVersion: version, reason })));
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
    expect(await audits()).toHaveLength(1);
    expect(await notificationsOf("poc_s001")).toHaveLength(1);
  });

  it("非表示になる前に開いていた画面からの本人の保存は409になる", async () => {
    const before = await userRow("poc_s001");
    expect((await hide("poc_school", id("poc_s001"), { expectedVersion: before.version, reason })).status).toBe(200);
    const stale = await saveProfile("poc_s001", { expectedVersion: before.profileVersion, displayName: "はる" });
    expect([stale.status, stale.body.error?.code]).toEqual([409, "VERSION_CONFLICT"]);
  });

  it("公開中の内容をプロフィールとアカウントの証拠として、非表示にする前に保全する", async () => {
    const profileCase = await newCase({ kind: "profile", userId: id("poc_s002") });
    const accountCase = await newCase({ kind: "account", userId: id("poc_s002") });
    const { version } = await userRow("poc_s002");
    expect((await hide("poc_school", id("poc_s002"), { expectedVersion: version, reason })).status).toBe(200);
    const evidence = await db.select({ caseId: reportCaseEvidence.caseId, snapshot: evidenceSnapshots.snapshot })
      .from(reportCaseEvidence).innerJoin(evidenceSnapshots, eq(evidenceSnapshots.id, reportCaseEvidence.evidenceId));
    const snapshotOf = (caseId: string) => evidence.find((row) => row.caseId === caseId)?.snapshot;
    expect(snapshotOf(profileCase)).toMatchObject({ fields: { displayName: "みなと" } });
    // 公開中の表示名を保全できている（非表示にした後では null になる）。
    expect(snapshotOf(accountCase)).toMatchObject({ displayName: "みなと" });
    expect(JSON.stringify(evidence)).not.toContain("Web開発");
  });

  it("アプリ管理者を非表示にすると、担当する未終了案件だけを引継ぎ待ちにする", async () => {
    const open = await newCase({ kind: "profile", userId: id("poc_s001") }, { assignee: "poc_a_mgr", status: "unhandled" });
    const closed = await newCase({ kind: "account", userId: id("poc_s001") }, { assignee: "poc_a_mgr", status: "closed" });
    const others = await newCase({ kind: "profile", userId: id("poc_s002") }, { assignee: "poc_s_mgr" });
    const { version } = await userRow("poc_a_mgr");
    expect((await hide("poc_school", id("poc_a_mgr"), { expectedVersion: version, reason })).status).toBe(200);
    expect(await caseRow(open)).toMatchObject({ assigneeId: null, handoffPending: true, status: "unhandled", version: 2 });
    expect(await caseRow(closed)).toMatchObject({ assigneeId: id("poc_a_mgr"), handoffPending: false, version: 1 });
    expect(await caseRow(others)).toMatchObject({ assigneeId: id("poc_s_mgr"), handoffPending: false, version: 1 });
    const actions = await db.select().from(reportActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      caseId: open, systemAction: true, actorId: null, actionType: "handoff_started",
      afterState: { assigneeId: null, handoffPending: true, trigger: "manager_profile_hidden" },
    });
  });

  it("通知の記録に失敗したら、非表示・監査・引継ぎもすべて取り消す", async () => {
    const open = await newCase({ kind: "profile", userId: id("poc_s001") }, { assignee: "poc_a_mgr" });
    const before = await userRow("poc_a_mgr");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.execute("ALTER TABLE notifications ADD CONSTRAINT reject_for_test CHECK (kind <> 'profile_hidden')");
    try {
      const failed = await hide("poc_school", id("poc_a_mgr"), { expectedVersion: before.version, reason });
      expect(failed.status).toBe(500);
      expect(failed.text).not.toContain(reason);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(reason);
    } finally {
      logged.mockRestore();
      await db.execute("ALTER TABLE notifications DROP CONSTRAINT reject_for_test");
    }
    await expectUnchanged("poc_a_mgr", before);
    expect(await caseRow(open)).toMatchObject({ assigneeId: id("poc_a_mgr"), handoffPending: false, version: 1 });
    expect(await db.select().from(operationReceipts)).toEqual([]);
  });
});

describe("API-US-05 sourceCaseId（通報案件を起点にした非表示）", () => {
  const attempt = async (actor: string, username: string, sourceCaseId: string) =>
    hide(actor, id(username), { expectedVersion: (await userRow(username)).version, reason, sourceCaseId });

  it.each(["profile", "account", "question", "response"] as const)("%s の案件の対象者を非表示にすると、案件の対応履歴に記録する", async (kind) => {
    const caseTarget: CaseTarget = kind === "question" ? { kind, questionId: await newQuestion("poc_s002") }
      : kind === "response" ? { kind, responseId: await newAnswer("poc_s002") } : { kind, userId: id("poc_s002") };
    const caseId = await newCase(caseTarget, { assignee: "poc_s_mgr", status: "unhandled" });
    expect((await attempt("poc_s_mgr", "poc_s002", caseId)).status).toBe(200);
    // 案件の状態・担当は変えず、版番号と履歴だけを進める。
    const row = await caseRow(caseId);
    expect(row).toMatchObject({ status: "unhandled", assigneeId: id("poc_s_mgr"), version: 2 });
    const [action, ...others] = await db.select().from(reportActions);
    expect(others).toEqual([]);
    expect(action).toMatchObject({
      caseId, actorId: id("poc_s_mgr"), systemAction: false, actionType: "profile_hidden",
      beforeState: { profileState: "public" }, afterState: { profileState: "hidden" }, note: null,
    });
    expect(row.updatedAt).toEqual(action.createdAt);
  });

  it("対象者の違う案件は422、対応済みは409、存在しない・閲覧できない案件は404で、非表示にしない", async () => {
    const mismatched = await newCase({ kind: "profile", userId: id("poc_s001") });
    const closed = await newCase({ kind: "profile", userId: id("poc_s002") }, { status: "closed" });
    const expired = await newCase({ kind: "account", userId: id("poc_s002") }, {
      status: "closed", closedAt: new Date(Date.now() - 367 * 24 * 60 * 60 * 1000),
    });
    const before = await userRow("poc_s002");

    const mismatch = await attempt("poc_school", "poc_s002", mismatched);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error?.fields).toMatchObject([{ path: "sourceCaseId", code: "case_target_mismatch" }]);
    const done = await attempt("poc_school", "poc_s002", closed);
    expect([done.status, done.body.error?.code]).toEqual([409, "CASE_CLOSED"]);
    expect((await attempt("poc_school", "poc_s002", expired)).status).toBe(404);
    expect((await attempt("poc_school", "poc_s002", randomUUID())).status).toBe(404);
    await expectUnchanged("poc_s002", before);
    expect(await db.select().from(reportActions)).toEqual([]);
  });

  it("学校専用・引継ぎ待ち・アプリ管理者が対象者の案件は、アプリ管理者には存在しない案件と同じ404にする", async () => {
    const schoolOnly = await newCase({ kind: "profile", userId: id("poc_s002") }, { schoolOnly: true });
    const handoff = await newCase({ kind: "account", userId: id("poc_s002") }, { assignee: null });
    const aboutManager = await newCase({ kind: "profile", userId: id("poc_a_mgr") });
    const before = await userRow("poc_s002");
    for (const caseId of [schoolOnly, handoff, aboutManager]) {
      expect((await attempt("poc_s_mgr", "poc_s002", caseId)).status).toBe(404);
    }
    await expectUnchanged("poc_s002", before);
    expect((await attempt("poc_school", "poc_s002", schoolOnly)).status).toBe(200);
  });

  it("再送時も起点の案件の現在の閲覧権限を確認し、閲覧できなくなった管理者には結果を返さない", async () => {
    const { version } = await userRow("poc_s002");
    const caseId = await newCase({ kind: "profile", userId: id("poc_s002") }, { assignee: "poc_s_mgr" });
    const key = `retry-${randomUUID()}`;
    const body = { expectedVersion: version, reason, sourceCaseId: caseId };
    const first = await hide("poc_s_mgr", id("poc_s002"), body, key);
    expect(first.status).toBe(200);
    const replay = async () => {
      const again = await hide("poc_s_mgr", id("poc_s002"), body, key);
      if (again.status === 200) expect(again.body.data).toEqual(first.body.data);
      else expect(again.text).not.toContain(id("poc_s002"));
      return again.status;
    };
    expect(await replay()).toBe(200);

    // 学校専用・引継ぎ待ちになった案件は、アプリ管理者の閲覧の対象外。
    const setCase = (values: Partial<typeof reportCases.$inferInsert>) =>
      db.update(reportCases).set(values).where(eq(reportCases.id, caseId));
    await setCase({ schoolOnly: true });
    expect(await replay()).toBe(404);
    await setCase({ schoolOnly: false, handoffPending: true, assigneeId: null });
    expect(await replay()).toBe(404);
    // その後に対応済みになっただけなら、確定済みの操作の結果を返す。閲覧期限を過ぎたら返さない。
    await setCase({ handoffPending: false, assigneeId: id("poc_s_mgr"), status: "closed", closedAt: new Date() });
    expect(await replay()).toBe(200);
    await setCase({ closedAt: new Date(Date.now() - 367 * 24 * 60 * 60 * 1000) });
    expect(await replay()).toBe(404);
    expect(await audits()).toHaveLength(1);
    expect(await db.select().from(reportActions)).toHaveLength(1);
  });

  it("再送時の閲覧権限は、処理中の案件の変更が確定した後の状態で判定する", async () => {
    const { version } = await userRow("poc_s002");
    const caseId = await newCase({ kind: "profile", userId: id("poc_s002") }, { assignee: "poc_s_mgr" });
    const key = `retry-${randomUUID()}`;
    const body = { expectedVersion: version, reason, sourceCaseId: caseId };
    expect((await hide("poc_s_mgr", id("poc_s002"), body, key)).status).toBe(200);
    const client = await pool.connect();
    let replayed: Promise<Result> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE report_cases SET school_only = true WHERE id = $1", [caseId]);
      replayed = hide("poc_s_mgr", id("poc_s002"), body, key);
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
      await replayed?.catch(() => {});
    }
    expect((await replayed).status).toBe(404);
  });

  it("関係する案件（措置の起点・証拠の保全・担当の引継ぎ）を、まとめてID順にロックする", async () => {
    const source = await newCase({ kind: "profile", userId: id("poc_a_mgr") }, { schoolOnly: true });
    const assigned: string[] = [];
    for (const username of ["poc_s001", "poc_s002", "poc_a001", "poc_staff"]) {
      assigned.push(await newCase({ kind: "profile", userId: id(username) }, { assignee: "poc_a_mgr" }));
    }
    // 起点の案件をID順の最後にし、起点を先にロックする実装では、後の案件のロックが逆順になるようにする。
    const last = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await db.update(reportCases).set({ id: last }).where(eq(reportCases.id, source));
    const [first, ...rest] = [...assigned].sort();

    await logIn("poc_school");
    const client = await pool.connect();
    let hiding: Promise<Result> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM report_cases WHERE id = $1 FOR UPDATE", [first]);
      hiding = attempt("poc_school", "poc_a_mgr", last);
      await vi.waitFor(async () => {
        const { rows } = await target.client.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()",
        );
        expect(rows.length).toBeGreaterThan(0);
      });
      // ID順の先頭で待っている間は、後ろの案件（起点を含む）をロックしていない。
      for (const caseId of [...rest, last]) {
        await client.query("SELECT id FROM report_cases WHERE id = $1 FOR UPDATE NOWAIT", [caseId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await hiding?.catch(() => {});
    }
    expect((await hiding).status).toBe(200);
    for (const caseId of assigned) expect(await caseRow(caseId)).toMatchObject({ handoffPending: true, version: 2 });
    expect(await caseRow(last)).toMatchObject({ assigneeId: id("poc_school"), version: 2 });
  });
});

describe("AD-11 利用者の基本情報", () => {
  const viewerOf = (username: string, schoolManager: boolean): Viewer => ({
    userId: id(username), baseRole: "staff", isGraduating: false, profileState: "public", userVersion: 1,
    roles: { schoolManager, appManager: !schoolManager },
  });

  it("公開中は公開表示名を返し、本人確認情報・停止理由を返さない", async () => {
    const { loadAdminUser } = await import("../../src/admin/users");
    const user = await loadAdminUser(db, viewerOf("poc_s_mgr", false), id("poc_suspended"));
    expect(user).toEqual({
      userId: id("poc_suspended"), displayName: "りく", baseRole: "student", isGraduating: false, accountStatus: "suspended",
      profileState: "public", roles: { schoolManager: false, appManager: false },
      version: (await userRow("poc_suspended")).version, profileHiding: "available",
    });
    await expect(loadAdminUser(db, viewerOf("poc_school", true), "no-such-user")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["poc_a_mgr", "poc_s001"])("非表示中の %s が保存した審査前の表示名を、どちらの管理者にも返さない", async (username) => {
    const { loadAdminUser } = await import("../../src/admin/users");
    const { version } = await userRow(username);
    expect((await hide("poc_school", id(username), { expectedVersion: version, reason })).status).toBe(200);
    const { profileVersion } = await userRow(username);
    expect((await saveProfile(username, { expectedVersion: profileVersion, displayName: "審査前の表示名" })).status).toBe(200);
    for (const viewer of [viewerOf("poc_s_mgr", false), viewerOf("poc_school", true)]) {
      const user = await loadAdminUser(db, viewer, id(username));
      expect(user).toMatchObject({ userId: id(username), displayName: null, profileState: "hidden" });
      expect(JSON.stringify(user)).not.toContain("審査前の表示名");
    }

    // 承認で公開されると、公開表示名として返す。
    const [pending] = (await list("poc_school")).body.data!.items!;
    expect((await decide("poc_school", String(pending.id), { expectedVersion: 1, decision: "approve" })).status).toBe(200);
    expect(await loadAdminUser(db, viewerOf("poc_s_mgr", false), id(username)))
      .toMatchObject({ displayName: "審査前の表示名", profileState: "public" });
  });
});

describe("API-PR-01 再公開審査の一覧", () => {
  it("審査待ちを申請日時の古い順に返し、件数も含めて取得できる申請だけを対象にする", async () => {
    const newer = await newReview("poc_s001", new Date("2026-11-02T00:00:00Z"));
    const older = await newReview("poc_s002", new Date("2026-11-01T00:00:00Z"));
    const manager = await newReview("poc_a_mgr", new Date("2026-10-31T00:00:00Z"));
    const school = await newReview("poc_school", new Date("2026-10-30T00:00:00Z"));

    const bySchool = await list("poc_school");
    expect(bySchool.status).toBe(200);
    expect(bySchool.body.data?.items?.map((item) => item.id)).toEqual([manager, older, newer]);
    expect(bySchool.body.data?.items?.[1]).toEqual({
      id: older, status: "pending", submittedAt: "2026-11-01T00:00:00.000Z", decidedAt: null, decisionReason: null, version: 1,
    });
    expect(bySchool.body.meta.page?.totalCount).toBe(3);
    expect(bySchool.text).not.toContain(school);

    // アプリ管理者には、アプリ管理者の申請を件数にも含めない。
    const byApp = await list("poc_s_mgr");
    expect(byApp.body.data?.items?.map((item) => item.id)).toEqual([older, newer]);
    expect(byApp.body.meta.page?.totalCount).toBe(2);
    expect(byApp.text).not.toContain(manager);
  });

  it("状態で絞り込み、審査待ち以外は新しい順に返す", async () => {
    const pending = await newReview("poc_s001", new Date("2026-11-03T00:00:00Z"));
    const approved = await newReview("poc_s002", new Date("2026-11-01T00:00:00Z"));
    const rejected = await newReview("poc_a001", new Date("2026-11-02T00:00:00Z"));
    const decided = { reviewerId: id("poc_school"), decidedAt: new Date() };
    await db.update(profileReviews).set({ status: "approved", ...decided }).where(eq(profileReviews.id, approved));
    await db.update(profileReviews).set({ status: "rejected", decisionReason: reason, ...decided }).where(eq(profileReviews.id, rejected));
    const idsOf = async (query: string) => (await list("poc_school", query)).body.data?.items?.map((item) => item.id);
    expect(await idsOf("?status=pending")).toEqual([pending]);
    expect(await idsOf("?status=approved")).toEqual([approved]);
    expect(await idsOf("?status=rejected")).toEqual([rejected]);
    expect(await idsOf("?status=all")).toEqual([pending, rejected, approved]);
  });

  it.each(["pending", "rejected"] as const)("%s の一覧を、同じミリ秒の申請でも抜け・重複なくページ送りできる", async (status) => {
    const created: string[] = [];
    for (const username of ["poc_s001", "poc_s002", "poc_a001", "poc_staff", "poc_hidden"]) {
      const reviewId = await newReview(username);
      created.push(reviewId);
      // 同じミリ秒の中のマイクロ秒の差と、完全に同じ時刻の両方を含める。
      const micros = 100 + Math.floor(created.length / 2);
      await target.client.query("UPDATE profile_reviews SET submitted_at = $1::timestamptz WHERE id = $2",
        [`2026-11-01T00:00:00.123${micros}Z`, reviewId]);
    }
    if (status === "rejected") {
      await db.update(profileReviews).set({
        status, decisionReason: reason, reviewerId: id("poc_school"), decidedAt: new Date(),
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Result = await list("poc_school", `?status=${status}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.body.meta.page?.totalCount).toBe(5);
      seen.push(...page.body.data!.items!.map((item) => String(item.id)));
      cursor = page.body.meta.page!.nextCursor;
    } while (cursor && seen.length < 20);
    const order = status === "pending" ? asc : desc;
    const expected = await db.select({ id: profileReviews.id }).from(profileReviews)
      .orderBy(order(profileReviews.submittedAt), order(profileReviews.id));
    expect(seen).toEqual(expected.map((row) => row.id));
    expect(new Set(seen)).toEqual(new Set(created));
  });

  it("条件・閲覧者の違うカーソルと、形式の誤った条件は400、資格のない利用者は403・401", async () => {
    await newReview("poc_s001", new Date("2026-11-01T00:00:00Z"));
    await newReview("poc_s002", new Date("2026-11-02T00:00:00Z"));
    const cursor = encodeURIComponent((await list("poc_school", "?limit=1")).body.meta.page!.nextCursor!);
    expect((await list("poc_school", `?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await list("poc_school", `?status=all&limit=1&cursor=${cursor}`)).body.error?.code).toBe("INVALID_CURSOR");
    expect((await list("poc_s_mgr", `?limit=1&cursor=${cursor}`)).body.error?.code).toBe("INVALID_CURSOR");
    for (const query of ["?status=withdrawn", "?status=", "?q=a", "?status=all&status=all", "?limit=51"]) {
      expect((await list("poc_school", query)).status, query).toBe(400);
    }
    await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, id("poc_a_mgr")));
    for (const username of ["poc_s001", "poc_staff", "poc_a_mgr"]) expect((await list(username)).status).toBe(403);
    expect((await list(null)).status).toBe(401);
  });
});

describe("API-PR-02 再公開審査の詳細", () => {
  it("AC-04 公開予定の基本項目と、本人が公開を許可した任意項目だけを返す", async () => {
    const reviewId = await newReview("poc_s002", new Date("2026-11-01T00:00:00Z"));
    const found = await detail("poc_s_mgr", reviewId);
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual({
      id: reviewId, status: "pending", submittedAt: "2026-11-01T00:00:00.000Z", decidedAt: null, decisionReason: null, version: 1,
      userId: id("poc_s002"), profileRevisionId: (await userRow("poc_s002")).currentRevisionId,
      profileFields: {
        displayName: "みなと", department: "IT学科（架空）", entryYear: null, graduationYear: 2026,
        optionalFields: { bio: { value: "開発用のサンプルプロフィールです。", visibility: "members" } },
      },
      capabilities: {
        canEdit: false, canDelete: false, canRespond: false, canResolve: false, canWithdraw: false, canResubmit: false,
        canCancel: false, canReview: true, canHide: false, canRestore: false,
      },
    });
    const [identity] = await db.select().from(identityRecords).where(eq(identityRecords.userId, id("poc_s002")));
    for (const secret of ["Web開発", "interests", identity.privateRealName, identity.schoolReference]) {
      expect(found.text).not.toContain(secret);
    }
  });

  it("AC-04 審査の確定後に本人が「自分だけ」に変えた項目は、過去の申請からも返さない", async () => {
    const reviewId = await newReview("poc_s002");
    expect((await decide("poc_school", reviewId, { expectedVersion: 1, decision: "reject", reason })).status).toBe(200);
    expect((await detail("poc_school", reviewId)).text).toContain("開発用のサンプルプロフィールです。");
    const { profileVersion } = await userRow("poc_s002");
    expect((await saveProfile("poc_s002", {
      expectedVersion: profileVersion, optionalFields: { bio: { visibility: "self" } },
    })).status).toBe(200);
    const past = await detail("poc_school", reviewId);
    expect(past.status).toBe(200);
    expect(past.text).not.toContain("開発用のサンプルプロフィールです。");
    expect(past.body.data).toMatchObject({ status: "rejected", capabilities: { canReview: false } });
  });

  it("アプリ管理者・学校管理者の申請は、取得できない管理者には存在しない申請と同じ404、形式の誤りは400", async () => {
    const manager = await newReview("poc_a_mgr");
    const missing = await detail("poc_s_mgr", randomUUID());
    const denied = await detail("poc_s_mgr", manager);
    expect([denied.status, denied.body.error]).toEqual([404, missing.body.error]);
    expect(denied.text).not.toContain("卒業生アプリ管理者");
    expect((await detail("poc_school", manager)).status).toBe(200);
    expect((await detail("poc_school", await newReview("poc_school"))).status).toBe(404);
    expect((await detail("poc_school", "not-a-uuid")).status).toBe(400);
    expect((await detail("poc_s001", manager)).status).toBe(403);
    expect((await detail(null, manager)).status).toBe(401);
  });
});

describe("API-PR-03 再公開の承認・却下", () => {
  it.each(["poc_school", "poc_s_mgr"])("AC-09 %s の承認でプロフィールが公開され、通知と監査を同時に記録する", async (actor) => {
    const reviewId = await newReview("poc_s001");
    const before = await userRow("poc_s001");
    const decided = await decide(actor, reviewId, { expectedVersion: 1, decision: "approve" });
    expect(decided.status).toBe(200);
    expect(decided.body.data).toMatchObject({ resource: { type: "profile_review", id: reviewId }, version: 2, state: "approved" });
    expect(await reviewRow(reviewId)).toMatchObject({ status: "approved", version: 2, reviewerId: id(actor), decisionReason: null });
    expect(await userRow("poc_s001")).toEqual({
      ...before, profileState: "public", version: before.version + 1, profileVersion: before.profileVersion + 1,
    });
    expect(await audits()).toMatchObject([{
      actorId: id(actor), actionType: "profile_review.approved", targetType: "profile_review", targetId: reviewId,
      beforeState: { status: "pending", profileState: "hidden", version: 1 },
      afterState: { status: "approved", profileState: "public", version: 2 }, publicReason: null,
    }]);
    expect(await notificationsOf("poc_s001")).toMatchObject([{
      kind: "profile_review_decided", profileReviewId: reviewId, publicMessage: "プロフィールの再公開が承認されました。",
    }]);
  });

  it("AC-09 却下では非表示と理由が維持され、本人はマイプロフィールと通知で理由を確認できる", async () => {
    const reviewId = await newReview("poc_s001");
    const before = await userRow("poc_s001");
    const decided = await decide("poc_s_mgr", reviewId, { expectedVersion: 1, decision: "reject", reason });
    expect(decided.body.data).toMatchObject({ version: 2, state: "rejected" });
    expect(await reviewRow(reviewId)).toMatchObject({ status: "rejected", decisionReason: reason, version: 2 });
    expect(await userRow("poc_s001")).toEqual(before);
    expect(await audits()).toMatchObject([{
      actionType: "profile_review.rejected", publicReason: reason,
      afterState: { status: "rejected", profileState: "hidden", version: 2 },
    }]);
    expect(await notificationsOf("poc_s001")).toMatchObject([{
      publicMessage: `プロフィールの再公開申請が却下されました。\n理由：${reason}`,
    }]);
    const mine = await result(await profileRoute.GET(new Request(`${origin}/api/v1/me/profile`, {
      headers: await headersFor("poc_s001"),
    }), {}));
    expect(mine.body.data).toMatchObject({ profileState: "hidden", review: { id: reviewId, status: "rejected", decisionReason: reason } });

    // 却下後に修正して保存すると、別の申請になる。
    expect((await saveProfile("poc_s001", { expectedVersion: before.profileVersion, searchOptIn: false })).status).toBe(200);
    const reviews = await db.select().from(profileReviews).where(eq(profileReviews.userId, id("poc_s001")));
    expect(reviews.map(({ status }) => status).sort()).toEqual(["pending", "rejected"]);
  });

  it("却下の理由がない・空白だけの場合と、形式の誤りは422で、申請を確定しない", async () => {
    const reviewId = await newReview("poc_s001");
    for (const body of [
      { expectedVersion: 1, decision: "reject" }, { expectedVersion: 1, decision: "reject", reason: null },
      { expectedVersion: 1, decision: "reject", reason: " \n" },
    ]) {
      const rejected = await decide("poc_school", reviewId, body);
      expect(rejected.status).toBe(422);
      expect(rejected.body.error?.fields).toMatchObject([{ path: "reason", code: "missing_reason" }]);
    }
    for (const body of [
      { expectedVersion: 1, decision: "approved" }, { decision: "approve" },
      { expectedVersion: 1, decision: "approve", userId: id("poc_s001") },
      { expectedVersion: 1, decision: "reject", reason: "あ".repeat(1001) },
    ]) expect((await decide("poc_school", reviewId, body)).status).toBe(422);
    expect(await reviewRow(reviewId)).toMatchObject({ status: "pending", version: 1 });
    expect(await audits()).toEqual([]);
  });

  it("AC-08 審査中に本人が修正すると、古い版の承認・却下を409で拒否し、新しい版だけを審査できる", async () => {
    const reviewId = await newReview("poc_s001");
    const { profileVersion } = await userRow("poc_s001");
    expect((await saveProfile("poc_s001", { expectedVersion: profileVersion, displayName: "はる（修正）" })).status).toBe(200);
    for (const body of [{ decision: "approve" }, { decision: "reject", reason }]) {
      const stale = await decide("poc_school", reviewId, { expectedVersion: 1, ...body });
      expect([stale.status, stale.body.error?.code]).toEqual([409, "VERSION_CONFLICT"]);
    }
    expect((await userRow("poc_s001")).profileState).toBe("hidden");
    expect(await notificationsOf("poc_s001")).toEqual([]);
    expect((await detail("poc_school", reviewId)).body.data).toMatchObject({ version: 2, profileFields: { displayName: "はる（修正）" } });
    expect((await decide("poc_school", reviewId, { expectedVersion: 2, decision: "approve" })).status).toBe(200);
    expect((await userRow("poc_s001")).profileState).toBe("public");
    expect((await reviewRow(reviewId)).revisionId).toBe((await userRow("poc_s001")).currentRevisionId);
  });

  it("本人の修正と承認が同時でも、審査していない内容は公開されない", async () => {
    for (const actor of ["poc_s001", "poc_school"]) await logIn(actor);
    for (let round = 0; round < 5; round++) {
      await db.delete(notifications);
      await db.delete(profileReviews);
      const reviewId = await newReview("poc_s001");
      const { profileVersion } = await userRow("poc_s001");
      const displayName = `同時の修正${round}`;
      const [saved, decided] = await Promise.all([
        saveProfile("poc_s001", { expectedVersion: profileVersion, displayName }),
        decide("poc_school", reviewId, { expectedVersion: 1, decision: "approve" }),
      ]);
      expect([saved.status, decided.status].sort()).toEqual([200, 409]);
      const [current] = await db.select({ displayName: profileRevisions.displayName }).from(profiles)
        .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId)).where(eq(profiles.userId, id("poc_s001")));
      const { profileState } = await userRow("poc_s001");
      expect(profileState === "public" && current.displayName === displayName).toBe(false);
    }
  });

  it("承認前の画面からの本人の保存は409になり、審査なしで公開されない", async () => {
    const reviewId = await newReview("poc_s001");
    const { profileVersion } = await userRow("poc_s001");
    expect((await decide("poc_school", reviewId, { expectedVersion: 1, decision: "approve" })).status).toBe(200);
    const stale = await saveProfile("poc_s001", { expectedVersion: profileVersion, displayName: "審査していない名前" });
    expect([stale.status, stale.body.error?.code]).toEqual([409, "VERSION_CONFLICT"]);
  });

  it("二重審査は409で拒否し、同時の審査は1件だけが確定する", async () => {
    const reviewId = await newReview("poc_s001");
    for (const actor of ["poc_school", "poc_s_mgr", "poc_staff_mgr"]) await logIn(actor);
    const results = await Promise.all([
      decide("poc_school", reviewId, { expectedVersion: 1, decision: "approve" }),
      decide("poc_s_mgr", reviewId, { expectedVersion: 1, decision: "reject", reason }),
      decide("poc_staff_mgr", reviewId, { expectedVersion: 1, decision: "reject", reason }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409, 409]);
    expect(await audits()).toHaveLength(1);
    expect(await notificationsOf("poc_s001")).toHaveLength(1);
    const { status, version } = await reviewRow(reviewId);
    expect((await userRow("poc_s001")).profileState).toBe(status === "approved" ? "public" : "hidden");
    const again = await decide("poc_school", reviewId, { expectedVersion: version, decision: "approve" });
    expect([again.status, again.body.error?.code]).toEqual([409, "STATE_CONFLICT"]);
  });

  it("アプリ管理者の申請は学校管理者だけが審査でき、取得できない管理者には404で状態を明かさない", async () => {
    const reviewId = await newReview("poc_a_mgr");
    for (const expectedVersion of [1, 9]) {
      const denied = await decide("poc_s_mgr", reviewId, { expectedVersion, decision: "approve" });
      expect([denied.status, denied.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    }
    // 本人は非表示中のため、管理操作の入口で拒否される（自己審査はできない）。
    expect((await decide("poc_a_mgr", reviewId, { expectedVersion: 1, decision: "approve" })).status).toBe(403);
    expect((await decide("poc_s001", reviewId, { expectedVersion: 1, decision: "approve" })).status).toBe(403);
    expect((await decide(null, reviewId, { expectedVersion: 1, decision: "approve" })).status).toBe(401);
    expect((await decide("poc_school", randomUUID(), { expectedVersion: 1, decision: "approve" })).status).toBe(404);
    expect(await reviewRow(reviewId)).toMatchObject({ status: "pending", version: 1 });
    expect((await decide("poc_school", reviewId, { expectedVersion: 1, decision: "approve" })).status).toBe(200);

    const school = await newReview("poc_school");
    expect((await decide("poc_school", school, { expectedVersion: 1, decision: "approve" })).status).toBe(404);
  });

  it("承認しても停止は解除せず、同じ再送キーの再送は通知・監査を重複させない", async () => {
    const reviewId = await newReview("poc_suspended");
    const key = `retry-${randomUUID()}`;
    const body = { expectedVersion: 1, decision: "approve" };
    const first = await decide("poc_s_mgr", reviewId, body, key);
    const again = await decide("poc_s_mgr", reviewId, body, key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body.data).toEqual(first.body.data);
    expect(again.body.meta.replayed).toBe(true);
    expect(await userRow("poc_suspended")).toMatchObject({ profileState: "public", accountStatus: "suspended" });
    expect(await audits()).toHaveLength(1);
    expect(await notificationsOf("poc_suspended")).toHaveLength(1);

    await db.update(communityUsers).set({ appManager: true }).where(eq(communityUsers.userId, id("poc_suspended")));
    expect((await decide("poc_s_mgr", reviewId, body, key)).status).toBe(404);
  });

  it("審査中の申請が現在の版を指していなければ、審査していない版を公開しないよう409にする", async () => {
    const reviewId = await newReview("poc_s001");
    const [latest] = await db.select().from(profileRevisions).where(eq(profileRevisions.userId, id("poc_s001")))
      .orderBy(desc(profileRevisions.revisionNo)).limit(1);
    const [other] = await db.insert(profileRevisions).values({
      userId: id("poc_s001"), revisionNo: latest.revisionNo + 1, displayName: "審査していない版",
    }).returning({ id: profileRevisions.id });
    await db.update(profiles).set({ currentRevisionId: other.id }).where(eq(profiles.userId, id("poc_s001")));
    const conflicted = await decide("poc_school", reviewId, { expectedVersion: 1, decision: "approve" });
    expect([conflicted.status, conflicted.body.error?.code]).toEqual([409, "STATE_CONFLICT"]);
    expect((await userRow("poc_s001")).profileState).toBe("hidden");
  });
});

it("非表示 → 本人の修正 → 承認 → 再度の非表示で、通知を区別して記録する", async () => {
  const { version } = await userRow("poc_a001");
  expect((await hide("poc_school", id("poc_a001"), { expectedVersion: version, reason })).status).toBe(200);
  const { profileVersion } = await userRow("poc_a001");
  expect((await saveProfile("poc_a001", { expectedVersion: profileVersion, searchOptIn: true })).body.data).toMatchObject({ state: "hidden" });
  const [pending] = (await list("poc_s_mgr")).body.data!.items!;
  expect((await decide("poc_s_mgr", String(pending.id), { expectedVersion: 1, decision: "approve" })).status).toBe(200);
  const after = await userRow("poc_a001");
  expect(after).toMatchObject({ profileState: "public", version: version + 2 });
  expect((await hide("poc_s_mgr", id("poc_a001"), { expectedVersion: after.version, reason: "2回目の理由" })).status).toBe(200);
  expect((await notificationsOf("poc_a001")).map(({ kind }) => kind))
    .toEqual(["profile_hidden", "profile_review_decided", "profile_hidden"]);
});
