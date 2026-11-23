import { and, asc, eq, inArray, or } from "drizzle-orm";
import { qaQuestions, qaResponses } from "../db/content-schema";
import { reportActions, reportCases, reportTargets } from "../db/moderation-schema";
import { communityUsers } from "../db/schema";
import { lockedCaseTime, type CaseWriter } from "./report-evidence";

/**
 * 担当案件の引継ぎと学校専用化（Issue #47 ④）。`commitMutation` の `execute` の中で、契機になった業務更新と同じ
 * トランザクションで呼ぶ（DB・ER設計書 §5「受領・担当・引継ぎ」、ロール・権限マトリクス詳細設計書 4.1）。
 *
 * - 引継ぎ待ちは、担当をなし（`assignee_id=null`）にして `handoff_pending=true` にする。対応状態（未対応／対応中）と
 *   過去の履歴は変えない。対応済みの案件は対象にしない。
 * - 変更した案件ごとに、`report_actions` へシステム操作（実行者なし）として契機と変更前後を記録し、版番号を上げる。
 *   更新時刻と履歴の時刻には、案件のロック後のDB時刻（`lockedCaseTime`）を使い、先に確定した更新より前にしない。
 * - 案件の行は `FOR UPDATE` でロックしてから判定する。ロック順は本体 → 申請 → 案件（共通認可条件表 §5）のため、
 *   本体・申請のロックを取得した後に呼ぶ。
 */

/** 引継ぎ・学校専用化の契機。`report_actions.after_state.trigger` に記録する。 */
export type HandoffTrigger =
  | "manager_profile_hidden"
  | "manager_suspended"
  | "manager_role_revoked"
  | "target_deleted"
  | "subject_became_app_manager";

/** `commitMutation` の `execute` が受け取る文脈のうち、ここで使うもの。 */
export type LockedCaseContext = { tx: CaseWriter; requireLockedUsers: (...ids: string[]) => void };

const openStatuses = ["unhandled", "in_progress"] as const;

type LockedCase = typeof reportCases.$inferSelect;

async function lockCases(tx: CaseWriter, condition: ReturnType<typeof and>): Promise<LockedCase[]> {
  return tx.select().from(reportCases).where(condition).orderBy(asc(reportCases.id)).for("update");
}

/** ロック済みの未終了案件を引継ぎ待ちにする。 */
async function startHandoff(tx: CaseWriter, cases: LockedCase[], trigger: HandoffTrigger): Promise<string[]> {
  const moved: string[] = [];
  const targets = cases.filter(({ status, handoffPending }) => status !== "closed" && !handoffPending);
  if (targets.length === 0) return moved;
  const at = await lockedCaseTime(tx);
  for (const reportCase of targets) {
    await tx.update(reportCases).set({
      assigneeId: null, handoffPending: true, version: reportCase.version + 1, updatedAt: at,
    }).where(eq(reportCases.id, reportCase.id));
    await tx.insert(reportActions).values({
      caseId: reportCase.id, actorId: null, systemAction: true, actionType: "handoff_started",
      beforeState: { assigneeId: reportCase.assigneeId, handoffPending: false },
      afterState: { assigneeId: null, handoffPending: true, trigger },
      createdAt: at,
    });
    moved.push(reportCase.id);
  }
  return moved;
}

/** 担当者のうち、学校管理者でない（アプリ管理者として担当している）案件だけを選ぶ。 */
async function assignedToNonSchoolManagers(tx: CaseWriter, cases: LockedCase[]): Promise<LockedCase[]> {
  const assignees = [...new Set(cases.flatMap(({ assigneeId }) => assigneeId ? [assigneeId] : []))];
  if (assignees.length === 0) return [];
  // 学校管理者の権限は発行コマンドだけで付与されるため、担当者の行をロックせずに読む。
  const schoolManagers = new Set((await tx.select({ userId: communityUsers.userId }).from(communityUsers)
    .where(and(inArray(communityUsers.userId, assignees), eq(communityUsers.schoolManager, true))))
    .map(({ userId }) => userId));
  return cases.filter(({ assigneeId }) => assigneeId !== null && !schoolManagers.has(assigneeId));
}

/**
 * 管理者が担当する未終了案件をすべて引継ぎ待ちにする。アプリ管理者のプロフィール非表示・停止・権限解除で使う。
 * 担当者の利用者行をロックしていること（割当と直列化するため）。戻り値は引継ぎ待ちにした案件のID。
 */
export async function handoffCasesAssignedTo(context: LockedCaseContext, input: {
  managerId: string;
  trigger: Extract<HandoffTrigger, "manager_profile_hidden" | "manager_suspended" | "manager_role_revoked">;
}): Promise<string[]> {
  context.requireLockedUsers(input.managerId);
  const cases = await lockCases(context.tx, and(
    eq(reportCases.assigneeId, input.managerId), inArray(reportCases.status, [...openStatuses]),
  ));
  return startHandoff(context.tx, cases, input.trigger);
}

/**
 * 通報対象のコンテンツを削除したとき、その対象の未終了案件のうち、アプリ管理者が担当する案件を引継ぎ待ちにする。
 * 削除済みの証拠は学校管理者しか閲覧できないため（AD-09／AD-17）。学校管理者が担当する案件はそのまま。
 * 削除前の証拠は `preserveEvidence` で先に保全する。戻り値は引継ぎ待ちにした案件のID。
 */
export async function handoffCasesOfDeletedTarget(context: LockedCaseContext, input: {
  target: { kind: "question"; questionId: string } | { kind: "response"; responseId: string };
}): Promise<string[]> {
  const condition = input.target.kind === "question"
    ? and(eq(reportTargets.kind, "question"), eq(reportTargets.questionId, input.target.questionId))
    : and(eq(reportTargets.kind, "response"), eq(reportTargets.responseId, input.target.responseId));
  const targets = await context.tx.select({ id: reportTargets.id }).from(reportTargets).where(condition);
  if (targets.length === 0) return [];
  const cases = await lockCases(context.tx, and(
    inArray(reportCases.targetId, targets.map(({ id }) => id)), inArray(reportCases.status, [...openStatuses]),
  ));
  return startHandoff(context.tx, await assignedToNonSchoolManagers(context.tx, cases), "target_deleted");
}

/**
 * 利用者がアプリ管理者になったとき、その利用者を対象者とする案件（プロフィール・アカウントへの通報と、その利用者が
 * 投稿した質問・回答等への通報）を学校専用にする。対応済みの案件も含め、学校専用は一度設定したら維持する。
 * 未終了の案件のうち、学校管理者でない管理者が担当する案件は引継ぎ待ちにする。
 * 対象者の利用者行をロックしていること。戻り値は学校専用にした案件と、引継ぎ待ちにした案件のID。
 */
export async function restrictCasesForNewAppManager(context: LockedCaseContext, input: {
  userId: string;
}): Promise<{ schoolOnly: string[]; handoff: string[] }> {
  context.requireLockedUsers(input.userId);
  const { tx } = context;
  const [questions, responses] = await Promise.all([
    tx.select({ id: qaQuestions.id }).from(qaQuestions).where(eq(qaQuestions.authorId, input.userId)),
    tx.select({ id: qaResponses.id }).from(qaResponses).where(eq(qaResponses.authorId, input.userId)),
  ]);
  const targetConditions = [eq(reportTargets.subjectUserId, input.userId)];
  if (questions.length) targetConditions.push(inArray(reportTargets.questionId, questions.map(({ id }) => id)));
  if (responses.length) targetConditions.push(inArray(reportTargets.responseId, responses.map(({ id }) => id)));
  const targets = await tx.select({ id: reportTargets.id }).from(reportTargets).where(or(...targetConditions));
  if (targets.length === 0) return { schoolOnly: [], handoff: [] };

  const cases = await lockCases(tx, inArray(reportCases.targetId, targets.map(({ id }) => id)));
  const schoolOnly: string[] = [];
  const restricted = cases.filter((reportCase) => !reportCase.schoolOnly);
  if (restricted.length) {
    const at = await lockedCaseTime(tx);
    for (const reportCase of restricted) {
      reportCase.version += 1;
      reportCase.schoolOnly = true;
      await tx.update(reportCases).set({ schoolOnly: true, version: reportCase.version, updatedAt: at })
        .where(eq(reportCases.id, reportCase.id));
      await tx.insert(reportActions).values({
        caseId: reportCase.id, actorId: null, systemAction: true, actionType: "school_only_applied",
        beforeState: { schoolOnly: false }, afterState: { schoolOnly: true, trigger: "subject_became_app_manager" },
        createdAt: at,
      });
      schoolOnly.push(reportCase.id);
    }
  }
  const open = cases.filter(({ status }) => status !== "closed");
  const handoff = await startHandoff(tx, await assignedToNonSchoolManagers(tx, open), "subject_became_app_manager");
  return { schoolOnly, handoff };
}
