import { and, eq, inArray, or } from "drizzle-orm";
import type { AccessReader, Viewer } from "@/auth/access";
import { reportActions, reportCases, reportTargets } from "@/db/moderation-schema";
import { requireViewableCase } from "@/reports/case-access";
import { lockedCaseTime, type CaseWriter } from "./report-evidence";
import { ApiError } from "./response";

/**
 * 通報案件を起点にした措置（`sourceCaseId`。API設計書 §11・§12）。案件の閲覧権限・未終了・対象の一致を確認し、
 * 措置を案件の対応履歴に同じトランザクションで記録する。
 */

/** 案件の対応履歴に残す措置と、変更前後に記録する項目。 */
export type CaseMeasure =
  | { actionType: "profile_hidden"; before: { profileState: "public" }; after: { profileState: "hidden" } }
  | { actionType: "qa_hidden"; before: { publicationState: "public" }; after: { publicationState: "hidden" } }
  | { actionType: "qa_restored"; before: { publicationState: "hidden" }; after: { publicationState: "public" } };

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

type CaseAccess = { actor: Pick<Viewer, "roles">; caseId: string; now: Date };

/**
 * 措置の起点の案件を、実行者が現在閲覧できることを確認する。案件の行は `targets` でロックしておく。
 * 閲覧できない案件は、存在しない案件と同じ 404。アプリ管理者は、学校専用・引継ぎ待ち・対象者がアプリ管理者の案件を
 * 閲覧できない（共通認可条件表 §4 AD-08／AD-09）。終了から1年を過ぎた案件は、学校管理者も閲覧できない。
 *
 * 再送（`authorizeReplay`）でも使う。確定済みの操作の結果を返すため、対応済みかどうかはここでは判定しない。
 */
export async function requireViewableMeasureCase(tx: CaseWriter, input: CaseAccess) {
  return requireViewableCase(tx, input.actor, input.caseId, input.now);
}

/** Q&Aの措置は、同じ投稿者の別の投稿ではなく、案件の対象投稿だけに記録する。 */
export async function requireQaMeasureCase(
  tx: CaseWriter,
  input: CaseAccess & { target: { type: "question" | "response"; id: string }; replay: boolean },
): Promise<void> {
  const row = await requireViewableMeasureCase(tx, input);
  const targetId = input.target.type === "question" ? row.questionId : row.responseId;
  if (targetId !== input.target.id) throw new ApiError("VALIDATION_FAILED", {
    fields: [{ path: "sourceCaseId", code: "case_target_mismatch", message: "この案件の対象投稿ではありません。" }],
  });
  if (!input.replay && row.status === "closed") throw new ApiError("CASE_CLOSED");
}

/**
 * 利用者への措置の起点にする案件を確認する。案件の行は `targets` でロックしておく。
 *
 * - 閲覧できない案件は 404（`requireViewableMeasureCase`）。
 * - 案件の対象者（プロフィール・アカウントの利用者本人、質問・回答等の投稿者。ReportCaseSummary の `subjectUserId`）が
 *   措置の対象と違えば 422。別の対象への操作を案件の履歴へ記録しない。
 * - 対応済みなら 409 CASE_CLOSED。
 */
export async function requireMeasureCase(tx: CaseWriter, input: CaseAccess & { userId: string }): Promise<void> {
  const { subjectUserId, status } = await requireViewableMeasureCase(tx, input);
  if (subjectUserId !== input.userId) {
    throw new ApiError("VALIDATION_FAILED", {
      fields: [{ path: "sourceCaseId", code: "case_target_mismatch", message: "この案件の対象者ではありません。" }],
    });
  }
  if (status === "closed") throw new ApiError("CASE_CLOSED");
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
