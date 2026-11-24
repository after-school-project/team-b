import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion } from "@/api/mutation";
import { recordNotification } from "@/api/notifications";
import { expectedVersion, requiredReason, uuid } from "@/api/request";
import { preserveEvidence, type CaseWriter } from "@/api/report-evidence";
import { handoffCasesAssignedTo } from "@/api/report-handoff";
import { recordCaseMeasure, requireMeasureCase } from "@/api/report-measures";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive } from "@/auth/access";
import { requireAdminForLockedTarget } from "@/auth/admin";
import { communityUsers, profiles } from "@/db/schema";

/**
 * プロフィールの非表示（API-US-05、AD-11）。Issue #8 ⑤。
 *
 * - 一般の利用者は有効な両管理者、アプリ管理者は学校管理者だけが操作できる。学校管理者は対象にできない
 *   （共通認可条件表 §4）。対象者が停止中でも操作できる。
 * - 公開への復帰は、本人の修正保存で作られる再公開申請の審査（`profile-reviews.ts`）で行う。
 * - 公開中の内容の証拠保全、担当案件の引継ぎ、監査ログ、本人への通知を同じトランザクションで確定する。
 */

/** API設計書 §12 ProfileHiding。 */
export const profileHidingSchema = z.strictObject({
  expectedVersion,
  /** 本人向けの理由。通知で本人に伝える（GE-02 には表示しない。2026-11-20 のチーム決定）。 */
  reason: requiredReason,
  sourceCaseId: uuid.optional(),
});

export type ProfileHiding = z.infer<typeof profileHidingSchema>;

type LockedContext = { tx: CaseWriter; now: Date; requireLockedUsers: (...ids: string[]) => void };

/**
 * 対象者への非表示操作の権限を、ロック後の最新状態で確認する。`execute` と `authorizeReplay` で呼ぶ。
 * 発行準備中の利用者は存在しないものとして扱う（公開プロフィールと同じ）。
 */
export async function authorizeProfileHiding(
  context: LockedContext, actorId: string, userId: string,
): Promise<{ appManager: boolean }> {
  const roles = await requireAdminForLockedTarget(context, actorId, userId);
  const [target] = await context.tx.select({ userId: communityUsers.userId }).from(communityUsers).where(and(
    eq(communityUsers.userId, userId),
    eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"),
  ));
  if (!target) throw new ApiError("NOT_FOUND");
  // 学校管理者のプロフィールは管理操作の対象外（CR-05）。
  if (roles.schoolManager) throw new ApiError("FORBIDDEN");
  return { appManager: roles.appManager };
}

/**
 * プロフィールを非表示にする。`commitMutation` の `execute` の中で呼び、`resolveUserIds` に対象者、`targets` に
 * 対象者の `profiles`（本体）と関係する案件をロックしておく。戻り値は変更後の利用者の版番号。
 */
export async function hideProfile(
  context: LockedContext, input: { actorId: string; userId: string; hiding: ProfileHiding },
): Promise<{ version: number }> {
  const { tx, now } = context;
  const { actorId, userId, hiding } = input;
  const { appManager } = await authorizeProfileHiding(context, actorId, userId);
  const sourceCase = hiding.sourceCaseId === undefined ? null : await requireMeasureCase(tx, {
    actor: requireActive(await loadAccessState(tx, actorId)), caseId: hiding.sourceCaseId, userId, now,
  });

  const [user] = await tx.select({ version: communityUsers.version, profileState: communityUsers.profileState })
    .from(communityUsers).where(eq(communityUsers.userId, userId));
  assertExpectedVersion(user.version, hiding.expectedVersion);
  if (user.profileState !== "public") throw new ApiError("STATE_CONFLICT");

  // 公開中の内容は、非表示にする前にプロフィールとアカウントの通報証拠として保全する（#47）。
  await preserveEvidence(tx, { targets: [{ kind: "profile", userId }, { kind: "account", userId }] });

  const version = user.version + 1;
  await tx.update(communityUsers).set({ profileState: "hidden", version }).where(eq(communityUsers.userId, userId));
  // 公開状態が変わるため、非表示になる前の画面からの本人の保存を409にする（API設計書 §16 更新結果の対象）。
  await tx.update(profiles).set({ version: sql`${profiles.version} + 1` }).where(eq(profiles.userId, userId));

  // アプリ管理者は管理機能を失うため、担当する未終了案件を引継ぎ待ちにする。
  if (appManager) await handoffCasesAssignedTo(context, { managerId: userId, trigger: "manager_profile_hidden" });
  if (sourceCase) {
    await recordCaseMeasure(tx, {
      caseId: sourceCase.id, actorId,
      measure: { actionType: "profile_hidden", before: { profileState: "public" }, after: { profileState: "hidden" } },
    });
  }

  const auditLogId = await recordAuditLog(tx, {
    action: "profile.hidden", actorId, targetId: userId,
    before: { profileState: "public" }, after: { profileState: "hidden" }, publicReason: hiding.reason, at: now,
  });
  await recordNotification(context, {
    recipientId: userId, actorId, at: now,
    subject: { kind: "profile_hidden", userId, auditLogId, publicReason: hiding.reason },
  });
  return { version };
}
