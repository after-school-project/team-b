import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedDevelopmentData } from "../../scripts/development-seed";
import { migrateDatabase } from "../../scripts/lib/database-management";
import { commitMutation } from "../../src/api/mutation";
import { preserveEvidence, type EvidenceTarget } from "../../src/api/report-evidence";
import {
  handoffCasesAssignedTo, handoffCasesOfDeletedTarget, restrictCasesForNewAppManager, type LockedCaseContext,
} from "../../src/api/report-handoff";
import * as auth from "../../src/db/auth-schema";
import * as content from "../../src/db/content-schema";
import * as moderation from "../../src/db/moderation-schema";
import * as community from "../../src/db/schema";
import { endPool, isolatedDatabase } from "./isolated-database";

/**
 * 通報証拠の保全と担当案件の引継ぎ（#47 ③④）。
 * AC-01：呼び出し元と同じトランザクションで保存され、ロールバックすると何も残らない。
 * AC-03：証拠に、秘密値・本人確認情報・`self` の任意プロフィール項目が含まれない。
 * AC-04：引継ぎ後は担当なし・引継ぎ待ちになり、対応状態と過去の履歴が変わらず、システム操作として記録される。
 */

vi.mock("server-only", () => ({}));

const { qaCategories, communityUsers } = community;
const { qaQuestions, qaResponses } = content;
const { evidenceSnapshots, reportActions, reportCaseEvidence, reportCases, reportTargets } = moderation;
const schema = { ...auth, ...content, ...community, ...moderation };

let target: Awaited<ReturnType<typeof isolatedDatabase>>;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
const ids = new Map<string, string>();
const id = (username: string) => {
  const value = ids.get(username);
  if (!value) throw new Error(`Missing seed account: ${username}`);
  return value;
};

beforeAll(async () => {
  target = await isolatedDatabase();
  await migrateDatabase(target.client);
  pool = new Pool({ connectionString: target.url.toString(), max: 5 });
  db = drizzle(pool, { schema });
  const credentialsDir = await mkdtemp(join(tmpdir(), "team-b-evidence-test-"));
  try {
    await seedDevelopmentData(drizzle(target.client), credentialsDir);
  } finally {
    await rm(credentialsDir, { recursive: true, force: true });
  }
  const rows = await db.select({ id: auth.user.id, username: auth.user.username }).from(auth.user);
  for (const { id: userId, username } of rows) if (username) ids.set(username, userId);
});

afterAll(async () => {
  await endPool(pool);
  await target?.dispose();
});

/** 指定した利用者行をロックしたトランザクションで、`commitMutation` の `execute` と同じ文脈を渡す。 */
function withLockedUsers<T>(userIds: string[], run: (context: LockedCaseContext) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (userIds.length) {
      await tx.select({ id: communityUsers.userId }).from(communityUsers)
        .where(inArray(communityUsers.userId, userIds)).orderBy(communityUsers.userId).for("update");
    }
    return run({
      tx,
      requireLockedUsers(...needed) {
        const missing = needed.filter((userId) => !userIds.includes(userId));
        if (missing.length) throw new Error(`ロックしていない利用者です：${missing.join(", ")}`);
      },
    });
  });
}

async function newQuestion(author: string, title = `通報対象の質問 ${randomUUID()}`): Promise<string> {
  const [category] = await db.select({ id: qaCategories.id }).from(qaCategories).limit(1);
  const [row] = await db.insert(qaQuestions).values({
    authorId: id(author), authorLabel: `${author} の表示名`, categoryId: category.id,
    title, bodyMarkdown: `質問本文 ${title}`,
  }).returning({ id: qaQuestions.id });
  return row.id;
}

async function newResponse(questionId: string, author: string, parentResponseId: string | null = null): Promise<string> {
  const [row] = await db.insert(qaResponses).values({
    questionId, authorId: id(author), authorLabel: `${author} の表示名`,
    kind: parentResponseId ? "reply" : "answer", parentResponseId, bodyMarkdown: `回答本文 ${randomUUID()}`,
  }).returning({ id: qaResponses.id });
  return row.id;
}

type CaseOptions = { status?: "unhandled" | "in_progress" | "closed"; assignee?: string | null };

/** 通報対象の行。なければ作る（対象ごとに1行）。 */
async function reportTargetId(caseTarget: EvidenceTarget): Promise<string> {
  const condition = caseTarget.kind === "question" ? eq(reportTargets.questionId, caseTarget.questionId)
    : caseTarget.kind === "response" ? eq(reportTargets.responseId, caseTarget.responseId)
      : and(eq(reportTargets.kind, caseTarget.kind), eq(reportTargets.subjectUserId, caseTarget.userId));
  const [existing] = await db.select({ id: reportTargets.id }).from(reportTargets).where(condition);
  if (existing) return existing.id;
  const values = caseTarget.kind === "question" ? { kind: caseTarget.kind, questionId: caseTarget.questionId }
    : caseTarget.kind === "response" ? { kind: caseTarget.kind, responseId: caseTarget.responseId }
      : { kind: caseTarget.kind, subjectUserId: caseTarget.userId };
  const [row] = await db.insert(reportTargets).values(values).returning({ id: reportTargets.id });
  return row.id;
}

/** 案件を作る。担当なしは引継ぎ待ちとして作る。 */
async function newCase(caseTarget: EvidenceTarget, { status = "in_progress", assignee = "poc_school" }: CaseOptions = {}) {
  const assigneeId = assignee === null ? null : id(assignee);
  const [row] = await db.insert(reportCases).values({
    targetId: await reportTargetId(caseTarget), status, assigneeId, handoffPending: assigneeId === null,
    closedAt: status === "closed" ? new Date() : null,
  }).returning();
  return row;
}

async function caseRow(caseId: string) {
  const [row] = await db.select().from(reportCases).where(eq(reportCases.id, caseId));
  return row;
}

async function evidenceOf(caseId: string) {
  return db.select({ id: evidenceSnapshots.id, snapshot: evidenceSnapshots.snapshot, sourceRevision: evidenceSnapshots.sourceRevision })
    .from(reportCaseEvidence).innerJoin(evidenceSnapshots, eq(evidenceSnapshots.id, reportCaseEvidence.evidenceId))
    .where(eq(reportCaseEvidence.caseId, caseId)).orderBy(asc(evidenceSnapshots.capturedAt));
}

describe("③ 通報証拠の保全", () => {
  it("質問の公開内容を保存して未終了案件に関連付け、同じ内容での再実行では重複させない", async () => {
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId });
    const first = await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    const again = await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    expect(first).toEqual({ evidenceId: again?.evidenceId, caseIds: [reportCase.id] });

    const [question] = await db.select().from(qaQuestions).where(eq(qaQuestions.id, questionId));
    const evidence = await evidenceOf(reportCase.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceRevision).toBe(question.version);
    expect(evidence[0].snapshot).toEqual({
      title: question.title, bodyMarkdown: question.bodyMarkdown, authorLabel: question.authorLabel,
    });
  });

  it("内容が変わった後に保全すると、新しい証拠を追加して同じ案件に関連付ける", async () => {
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId });
    await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    await db.update(qaQuestions).set({ bodyMarkdown: "編集後の本文", version: 2 }).where(eq(qaQuestions.id, questionId));
    await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    const evidence = await evidenceOf(reportCase.id);
    expect(evidence.map(({ sourceRevision }) => sourceRevision)).toEqual([1, 2]);
    expect(evidence[1].snapshot).toMatchObject({ bodyMarkdown: "編集後の本文" });
  });

  it("通報対象がない対象・未終了案件がない対象では何もしない", async () => {
    const unreported = await newQuestion("poc_s001");
    const closedOnly = await newQuestion("poc_s001");
    await newCase({ kind: "question", questionId: closedOnly }, { status: "closed" });
    const before = await db.select({ id: evidenceSnapshots.id }).from(evidenceSnapshots);
    expect(await preserveEvidence(db, { target: { kind: "question", questionId: unreported }, at: new Date() })).toBeNull();
    expect(await preserveEvidence(db, { target: { kind: "question", questionId: closedOnly }, at: new Date() })).toBeNull();
    expect(await db.select({ id: evidenceSnapshots.id }).from(evidenceSnapshots)).toHaveLength(before.length);
  });

  it("回答等の証拠には、親投稿の本文を含めない", async () => {
    const questionId = await newQuestion("poc_s001");
    const answerId = await newResponse(questionId, "poc_s001");
    const replyId = await newResponse(questionId, "poc_s002", answerId);
    const reportCase = await newCase({ kind: "response", responseId: replyId });
    await preserveEvidence(db, { target: { kind: "response", responseId: replyId }, at: new Date() });
    const [reply] = await db.select().from(qaResponses).where(eq(qaResponses.id, replyId));
    const [evidence] = await evidenceOf(reportCase.id);
    expect(evidence.snapshot).toEqual({
      bodyMarkdown: reply.bodyMarkdown, authorLabel: reply.authorLabel, kind: "reply", questionId, parentResponseId: answerId,
    });
  });

  it("証拠に含めない項目だけが変わって版番号が上がっても、同じ内容の証拠を再利用する", async () => {
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId });
    const first = await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    await db.update(qaQuestions).set({ resolution: "resolved", version: 2 }).where(eq(qaQuestions.id, questionId));
    const again = await preserveEvidence(db, { target: { kind: "question", questionId }, at: new Date() });
    expect(again?.evidenceId).toBe(first?.evidenceId);
    const evidence = await evidenceOf(reportCase.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceRevision).toBe(1);
  });

  it("非表示中に保存を続けても、再公開の承認前の版を証拠に保存しない", async () => {
    const userId = id("poc_staff");
    const profileCase = await newCase({ kind: "profile", userId });
    const accountCase = await newCase({ kind: "account", userId });
    const preserve = (kind: "profile" | "account") => preserveEvidence(db, { target: { kind, userId }, at: new Date() });
    /** 本人の保存と同じく、新しい版を作って現在版にする。 */
    const save = async (revisionNo: number, displayName: string) => {
      const [revision] = await db.insert(community.profileRevisions).values({
        userId, revisionNo, displayName,
        optionalValues: { bio: `${displayName}の自己紹介` }, fieldVisibility: { bio: "members" },
      }).returning({ id: community.profileRevisions.id });
      await db.update(community.profiles).set({ currentRevisionId: revision.id }).where(eq(community.profiles.userId, userId));
    };

    expect(await preserve("profile")).not.toBeNull(); // 公開中の版（1版）
    await db.update(communityUsers).set({ profileState: "hidden" }).where(eq(communityUsers.userId, userId));
    await save(2, "未承認の表示名二");
    expect(await preserve("profile")).toBeNull();
    await preserve("account");
    await save(3, "未承認の表示名三");
    expect(await preserve("profile")).toBeNull();
    await preserve("account");

    const hiddenEvidence = [...await evidenceOf(profileCase.id), ...await evidenceOf(accountCase.id)];
    expect(hiddenEvidence.map(({ snapshot }) => JSON.stringify(snapshot)).join()).not.toContain("未承認");
    expect((await evidenceOf(profileCase.id)).map(({ sourceRevision }) => sourceRevision)).toEqual([1]);
    expect((await evidenceOf(accountCase.id)).map(({ snapshot }) => snapshot)).toEqual([
      { userId, displayName: null, baseRole: "staff" },
    ]);

    // 再公開の承認後は、承認された現在版が公開版になる。
    await db.update(communityUsers).set({ profileState: "public" }).where(eq(communityUsers.userId, userId));
    await preserve("profile");
    expect((await evidenceOf(profileCase.id)).map(({ sourceRevision }) => sourceRevision)).toEqual([1, 3]);
  });

  it("AC-03 プロフィール・アカウントの証拠に、本人確認情報と本人のみの任意項目を含めない", async () => {
    const userId = id("poc_s002");
    const profileCase = await newCase({ kind: "profile", userId });
    const accountCase = await newCase({ kind: "account", userId });
    await preserveEvidence(db, { target: { kind: "profile", userId }, at: new Date() });
    await preserveEvidence(db, { target: { kind: "account", userId }, at: new Date() });

    const [profileEvidence] = await evidenceOf(profileCase.id);
    expect(profileEvidence.sourceRevision).toBe(1);
    expect(profileEvidence.snapshot).toEqual({
      userId, baseRole: "student", isGraduating: true,
      fields: {
        displayName: "みなと", department: "IT学科（架空）", entryYear: null, graduationYear: 2026,
        optionalFields: { bio: { value: "開発用のサンプルプロフィールです。", visibility: "members" } },
      },
    });
    const [accountEvidence] = await evidenceOf(accountCase.id);
    expect(accountEvidence.snapshot).toEqual({ userId, displayName: "みなと", baseRole: "student" });

    const [identity] = await db.select().from(community.identityRecords).where(eq(community.identityRecords.userId, userId));
    for (const evidence of [profileEvidence, accountEvidence]) {
      const json = JSON.stringify(evidence.snapshot);
      expect(json).not.toContain("Web開発"); // 本人のみ（self）の関心分野
      expect(json).not.toContain(identity.privateRealName);
      expect(json).not.toContain(identity.schoolReference);
      expect(json).not.toMatch(/schoolManager|appManager|accountStatus|password/);
    }
  });

  it("AC-01 業務更新が失敗すると、証拠も関連付けも残らない", async () => {
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId });
    const actorId = id("poc_s001");
    await expect(commitMutation(db, {
      actorId,
      request: { method: "POST", path: `/api/v1/questions/${questionId}/deletion`, requestKey: `delete-${randomUUID()}` },
      body: { confirmed: true },
      authorizeEntry: async () => {},
      authorizeReplay: async () => {},
      async execute({ tx, now }) {
        await preserveEvidence(tx, { target: { kind: "question", questionId }, at: now });
        await tx.update(qaQuestions).set({ deletedAt: now }).where(eq(qaQuestions.id, questionId));
        throw new Error("fixture failure");
      },
    })).rejects.toThrow("fixture failure");
    expect(await evidenceOf(reportCase.id)).toHaveLength(0);
    const [question] = await db.select({ deletedAt: qaQuestions.deletedAt }).from(qaQuestions).where(eq(qaQuestions.id, questionId));
    expect(question.deletedAt).toBeNull();
  });
});

describe("④ 担当案件の引継ぎ", () => {
  it("AC-04 管理者の未終了の担当案件だけを引継ぎ待ちにし、対応状態と過去の履歴を維持して、システム操作として記録する", async () => {
    const manager = id("poc_s_mgr");
    const questions = await Promise.all([1, 2, 3, 4].map(() => newQuestion("poc_s001")));
    const unhandled = await newCase({ kind: "question", questionId: questions[0] }, { status: "unhandled", assignee: "poc_s_mgr" });
    const inProgress = await newCase({ kind: "question", questionId: questions[1] }, { assignee: "poc_s_mgr" });
    const closed = await newCase({ kind: "question", questionId: questions[2] }, { status: "closed", assignee: "poc_s_mgr" });
    const others = await newCase({ kind: "question", questionId: questions[3] }, { assignee: "poc_school" });
    const [history] = await db.insert(reportActions).values({
      caseId: inProgress.id, actorId: manager, actionType: "status_changed",
      beforeState: { status: "unhandled" }, afterState: { status: "in_progress" }, note: "対応を開始しました。",
    }).returning();

    const at = new Date();
    const moved = await withLockedUsers([manager], (context) => handoffCasesAssignedTo(context, {
      managerId: manager, trigger: "manager_role_revoked", at,
    }));
    expect(new Set(moved)).toEqual(new Set([unhandled.id, inProgress.id]));

    for (const before of [unhandled, inProgress]) {
      const after = await caseRow(before.id);
      expect(after).toMatchObject({
        assigneeId: null, handoffPending: true, status: before.status, priority: before.priority,
        schoolOnly: false, version: before.version + 1, closedAt: null,
      });
      const actions = await db.select().from(reportActions).where(eq(reportActions.caseId, before.id))
        .orderBy(asc(reportActions.createdAt));
      expect(actions.at(-1)).toMatchObject({
        actorId: null, systemAction: true, actionType: "handoff_started",
        beforeState: { assigneeId: manager, handoffPending: false },
        afterState: { assigneeId: null, handoffPending: true, trigger: "manager_role_revoked" },
      });
      expect(actions.at(-1)?.createdAt.toISOString()).toBe(at.toISOString());
    }
    const [kept] = await db.select().from(reportActions).where(eq(reportActions.id, history.id));
    expect(kept).toEqual(history);
    expect(await caseRow(closed.id)).toEqual(closed);
    expect(await caseRow(others.id)).toEqual(others);
  });

  it("担当者の利用者行をロックしていなければ、何も変えずにやり直しを求める", async () => {
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId }, { assignee: "poc_a_mgr" });
    await expect(withLockedUsers([], (context) => handoffCasesAssignedTo(context, {
      managerId: id("poc_a_mgr"), trigger: "manager_suspended", at: new Date(),
    }))).rejects.toThrow("ロックしていない利用者です");
    expect(await caseRow(reportCase.id)).toEqual(reportCase);
  });

  it("通報対象の削除では、アプリ管理者が担当する案件だけを引継ぎ待ちにする", async () => {
    const byAppManager = await newQuestion("poc_s001");
    const bySchool = await newQuestion("poc_s001");
    const appManagerCase = await newCase({ kind: "question", questionId: byAppManager }, { assignee: "poc_staff_mgr" });
    const schoolCase = await newCase({ kind: "question", questionId: bySchool }, { assignee: "poc_school" });
    const answerId = await newResponse(byAppManager, "poc_s002");
    const responseCase = await newCase({ kind: "response", responseId: answerId }, { status: "unhandled", assignee: "poc_a_mgr" });

    const moved = await withLockedUsers([], async (context) => [
      ...await handoffCasesOfDeletedTarget(context, { target: { kind: "question", questionId: byAppManager }, at: new Date() }),
      ...await handoffCasesOfDeletedTarget(context, { target: { kind: "question", questionId: bySchool }, at: new Date() }),
      ...await handoffCasesOfDeletedTarget(context, { target: { kind: "response", responseId: answerId }, at: new Date() }),
    ]);
    expect(new Set(moved)).toEqual(new Set([appManagerCase.id, responseCase.id]));
    expect(await caseRow(appManagerCase.id)).toMatchObject({ assigneeId: null, handoffPending: true, status: "in_progress" });
    expect(await caseRow(responseCase.id)).toMatchObject({ assigneeId: null, handoffPending: true, status: "unhandled" });
    expect(await caseRow(schoolCase.id)).toEqual(schoolCase);
    const [action] = await db.select().from(reportActions).where(eq(reportActions.caseId, appManagerCase.id));
    expect(action.afterState).toMatchObject({ trigger: "target_deleted" });
  });

  it("アプリ管理者になった利用者の案件を学校専用にし、未終了でアプリ管理者が担当する案件だけを引継ぎ待ちにする", async () => {
    // poc_a001 を対象者とする案件は、このテストで作るものだけにする。
    const userId = id("poc_a001");
    const questionId = await newQuestion("poc_a001");
    const unrelatedQuestion = await newQuestion("poc_s001");
    const profileCase = await newCase({ kind: "profile", userId }, { assignee: "poc_a_mgr" });
    const accountCase = await newCase({ kind: "account", userId }, { status: "closed", assignee: "poc_a_mgr" });
    const questionCase = await newCase({ kind: "question", questionId }, { assignee: "poc_school" });
    const unrelated = await newCase({ kind: "question", questionId: unrelatedQuestion }, { assignee: "poc_a_mgr" });

    const result = await withLockedUsers([userId], (context) => restrictCasesForNewAppManager(context, { userId, at: new Date() }));
    expect(new Set(result.schoolOnly)).toEqual(new Set([profileCase.id, accountCase.id, questionCase.id]));
    expect(result.handoff).toEqual([profileCase.id]);
    expect(await caseRow(profileCase.id)).toMatchObject({
      schoolOnly: true, assigneeId: null, handoffPending: true, status: "in_progress", version: profileCase.version + 2,
    });
    expect(await caseRow(accountCase.id)).toMatchObject({
      schoolOnly: true, assigneeId: id("poc_a_mgr"), handoffPending: false, status: "closed",
    });
    expect(await caseRow(questionCase.id)).toMatchObject({
      schoolOnly: true, assigneeId: id("poc_school"), handoffPending: false,
    });
    expect(await caseRow(unrelated.id)).toEqual(unrelated);
    const actions = await db.select().from(reportActions).where(eq(reportActions.caseId, profileCase.id))
      .orderBy(asc(reportActions.actionType));
    expect(actions.map(({ actionType, systemAction }) => [actionType, systemAction])).toEqual([
      ["handoff_started", true], ["school_only_applied", true],
    ]);

    const again = await withLockedUsers([userId], (context) => restrictCasesForNewAppManager(context, { userId, at: new Date() }));
    expect(again).toEqual({ schoolOnly: [], handoff: [] });
  });

  it("AC-01 業務更新が失敗すると、引継ぎも履歴も残らない", async () => {
    const manager = id("poc_staff_mgr");
    const questionId = await newQuestion("poc_s001");
    const reportCase = await newCase({ kind: "question", questionId }, { assignee: "poc_staff_mgr" });
    await expect(commitMutation(db, {
      actorId: id("poc_school"),
      request: { method: "POST", path: `/api/v1/admin/users/${manager}/app-manager-role`, requestKey: `revoke-${randomUUID()}` },
      body: { assigned: false },
      resolveUserIds: async () => [manager],
      authorizeEntry: async () => {},
      authorizeReplay: async () => {},
      async execute(context) {
        await context.tx.update(communityUsers).set({ appManager: false }).where(eq(communityUsers.userId, manager));
        await handoffCasesAssignedTo(context, { managerId: manager, trigger: "manager_role_revoked", at: context.now });
        throw new Error("fixture failure");
      },
    })).rejects.toThrow("fixture failure");
    expect(await caseRow(reportCase.id)).toEqual(reportCase);
    expect(await db.select().from(reportActions).where(eq(reportActions.caseId, reportCase.id))).toHaveLength(0);
    const [user] = await db.select({ appManager: communityUsers.appManager }).from(communityUsers)
      .where(eq(communityUsers.userId, manager));
    expect(user.appManager).toBe(true);
  });
});
