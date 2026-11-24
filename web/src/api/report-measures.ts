import { and, eq, inArray, or } from "drizzle-orm";
import type { AccessReader, Viewer } from "@/auth/access";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { reportActions, reportCases, reportTargets } from "@/db/moderation-schema";
import { communityUsers } from "@/db/schema";
import { lockedCaseTime, type CaseWriter } from "./report-evidence";
import { ApiError } from "./response";

/**
 * 通報案件を起点にした措置（`sourceCaseId`。API設計書 §11・§12）。案件の閲覧権限・未終了・対象の一致を確認し、
 * 措置を案件の対応履歴に同じトランザクションで記録する。
 *
 * 案件の一覧・詳細・状態変更などは #15 で実装する。ここでは措置を案件に記録するために必要な判定だけを行う。
 */

/** 案件の閲覧期限（終了からの年数）。API設計書 §13。 */
const closedCaseRetentionYears = 1;

/** 案件の対応履歴に残す措置と、変更前後に記録する項目。 */
export type CaseMeasure = { actionType: "profile_hidden"; before: { profileState: "public" }; after: { profileState: "hidden" } };

/**
 * 利用者のプロフィールを非表示にするときにロックする未終了案件のID。対象者への通報案件（証拠の保全）と、対象者が
 * 管理者として担当する案件（引継ぎ）の両方を含む。`commitMutation` の `targets` に、措置の起点の案件と合わせて渡す。
 * 証拠の保全・引継ぎ・措置の記録は別々の問い合わせで案件をロックするため、先に全体をID順に1回でロックし、
 * 案件をID順にロックするほかの処理とデッドロックしないようにする。
 */
export async function openCaseIdsOfUser(reader: AccessReader, userId: string): Promise<string[]> {
  const rows = await reader.select({ id: reportCases.id }).from(reportCases)
    .innerJoin(reportTargets, eq(reportTargets.id, reportCases.targetId))
    .where(and(
      inArray(reportCases.status, ["unhandled", "in_progress"]),
      or(eq(reportTargets.subjectUserId, userId), eq(reportCases.assigneeId, userId)),
    ));
  return rows.map(({ id }) => id);
}

export type MeasureCase = Pick<typeof reportCases.$inferSelect, "id" | "version">;

/**
 * 利用者への措置の起点にする案件を確認する。案件の行は `targets` でロックしておく。
 *
 * - 閲覧できない案件は、存在しない案件と同じ 404。アプリ管理者は、学校専用・引継ぎ待ち・対象者がアプリ管理者の案件を
 *   閲覧できない（共通認可条件表 §4 AD-08／AD-09）。終了から1年を過ぎた案件は、学校管理者も閲覧できない。
 * - 案件の対象者（プロフィール・アカウントの利用者本人、質問・回答等の投稿者。ReportCaseSummary の `subjectUserId`）が
 *   措置の対象と違えば 422。別の対象への操作を案件の履歴へ記録しない。
 * - 対応済みなら 409 CASE_CLOSED。
 */
export async function requireMeasureCase(
  tx: CaseWriter,
  input: { actor: Pick<Viewer, "roles">; caseId: string; userId: string; now: Date },
): Promise<MeasureCase> {
  const [row] = await tx.select({
    id: reportCases.id,
    version: reportCases.version,
    status: reportCases.status,
    schoolOnly: reportCases.schoolOnly,
    handoffPending: reportCases.handoffPending,
    closedAt: reportCases.closedAt,
    subjectUserId: reportTargets.subjectUserId,
    questionAuthorId: qaQuestions.authorId,
    responseAuthorId: qaResponses.authorId,
  }).from(reportCases)
    .innerJoin(reportTargets, eq(reportTargets.id, reportCases.targetId))
    .leftJoin(qaQuestions, eq(qaQuestions.id, reportTargets.questionId))
    .leftJoin(qaResponses, eq(qaResponses.id, reportTargets.responseId))
    .where(eq(reportCases.id, input.caseId));
  if (!row) throw new ApiError("NOT_FOUND");
  const subjectUserId = row.subjectUserId ?? row.questionAuthorId ?? row.responseAuthorId;

  if (row.closedAt) {
    const expiresAt = new Date(row.closedAt);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + closedCaseRetentionYears);
    if (expiresAt <= input.now) throw new ApiError("NOT_FOUND");
  }
  if (!input.actor.roles.schoolManager) {
    if (row.schoolOnly || row.handoffPending) throw new ApiError("NOT_FOUND");
    const [subject] = subjectUserId === null ? [] : await tx.select({ appManager: communityUsers.appManager })
      .from(communityUsers).where(eq(communityUsers.userId, subjectUserId));
    if (subject?.appManager) throw new ApiError("NOT_FOUND");
  }

  if (subjectUserId !== input.userId) {
    throw new ApiError("VALIDATION_FAILED", {
      fields: [{ path: "sourceCaseId", code: "case_target_mismatch", message: "この案件の対象者ではありません。" }],
    });
  }
  if (row.status === "closed") throw new ApiError("CASE_CLOSED");
  return { id: row.id, version: row.version };
}

/**
 * 措置を案件の対応履歴に記録し、案件の版番号と更新時刻を進める。`requireMeasureCase` で確認した案件を渡す。
 * 同じトランザクションの引継ぎなどで版番号が進んでいても上書きしないよう、現在の版から進める。
 */
export async function recordCaseMeasure(
  tx: CaseWriter,
  input: { caseId: string; actorId: string; measure: CaseMeasure },
): Promise<void> {
  const [current] = await tx.select({ version: reportCases.version }).from(reportCases)
    .where(eq(reportCases.id, input.caseId));
  if (!current) throw new Error("措置の起点の案件が見つかりません。");
  const at = await lockedCaseTime(tx);
  await tx.update(reportCases).set({ version: current.version + 1, updatedAt: at }).where(eq(reportCases.id, input.caseId));
  await tx.insert(reportActions).values({
    caseId: input.caseId, actorId: input.actorId, systemAction: false, actionType: input.measure.actionType,
    beforeState: input.measure.before, afterState: input.measure.after, createdAt: at,
  });
}
