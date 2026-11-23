import { z } from "zod";
import { auditLogs } from "../db/moderation-schema";
import type { RecordWriter } from "./notifications";

/**
 * 監査ログの記録（Issue #47 ②）。`commitMutation` の `execute` の中で、業務更新と同じトランザクションで呼ぶ。
 *
 * before/after には、操作ごとの許可リストにある項目だけを、項目ごとに許可した値（状態の列挙値・版番号・真偽値・ID）
 * として記録する。項目名が正しくても、許可しない値（任意の文字列など）は記録しない。これにより、呼び出し側で項目を
 * 取り違えても、秘密値・ハッシュ・セッショントークン・投稿本文・本人確認情報・本人のみの任意プロフィール項目を
 * コピーしない（DB・ER設計書 §5、API設計書 §14）。
 *
 * 許可リストには、このIssueで #8 が使う操作を定める。その他の操作は、その操作を実装する各機能Issueで追加する。
 * 監査ログの閲覧（API-LOG-01・02）は #16 で実装する。
 */

const profileState = z.enum(["public", "hidden"]);
const reviewStatus = z.enum(["pending", "approved", "rejected"]);
const version = z.number().int().positive();
const graduationRole = z.enum(["student", "alumni"]);
const graduationFields = { baseRole: graduationRole, isGraduating: z.boolean(), version, batchId: z.uuid() };

/** 操作ごとの対象の種類と、before/after に入れてよい項目とその値。 */
export const auditOperations = {
  /** プロフィールの非表示（API-US-05）。対象は利用者。publicReason に本人向け理由を記録する。 */
  "profile.hidden": { targetType: "user", fields: { profileState } },
  /** 再公開審査の承認（API-PR-03）。対象は審査。 */
  "profile_review.approved": { targetType: "profile_review", fields: { status: reviewStatus, profileState, version } },
  /** 再公開審査の却下（API-PR-03）。対象は審査。publicReason に却下理由を記録する。 */
  "profile_review.rejected": { targetType: "profile_review", fields: { status: reviewStatus, profileState, version } },
  /** 卒業区分の一括変更（API-GR-02）。対象者ごとに1件記録する。 */
  "graduation.graduated": { targetType: "user", fields: graduationFields },
  /** 卒業区分の誤変更修正（API-GR-03）。 */
  "graduation.corrected": { targetType: "user", fields: graduationFields },
} as const satisfies Record<string, { targetType: string; fields: Record<string, z.ZodType> }>;

export type AuditAction = keyof typeof auditOperations;
type AuditFields<A extends AuditAction> = (typeof auditOperations)[A]["fields"];
type AuditState<A extends AuditAction> = { [K in keyof AuditFields<A>]?: z.infer<AuditFields<A>[K]> };

export type AuditLogInput<A extends AuditAction> = {
  action: A;
  /** 操作した利用者のID。システム処理（期限による自動処理など）は null。 */
  actorId: string | null;
  targetId: string;
  before?: AuditState<A>;
  after?: AuditState<A>;
  /** 本人向けに示す理由。内部メモは記録しない。 */
  publicReason?: string;
  /** 記録時刻。`commitMutation` の `now` を渡す。 */
  at: Date;
};

function allowedState(action: AuditAction, side: "before" | "after", state: unknown): Record<string, unknown> | null {
  if (state === undefined) return null;
  // 型チェックを経由しない呼び出し（スプレッドした行など）でも、許可外の項目・値を保存しない。
  const result = z.strictObject(auditOperations[action].fields).partial().safeParse(state);
  if (!result.success) {
    // 渡された値は秘密値の可能性があるため、例外のメッセージには項目名だけを含める。
    const fields = [...new Set(result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : [issue.path.join(".")]))];
    throw new Error(`監査ログ ${action} の ${side} に許可されていない項目または値があります：${fields.join(", ")}`);
  }
  return result.data;
}

/** 監査ログを1件記録し、そのIDを返す。非表示の通知では、このIDを契機IDに使う。 */
export async function recordAuditLog<A extends AuditAction>(tx: RecordWriter, input: AuditLogInput<A>): Promise<string> {
  const reason = input.publicReason?.trim();
  if (input.publicReason !== undefined && !reason) throw new Error("監査ログの理由が空です。理由がない場合は省略してください。");
  const [saved] = await tx.insert(auditLogs).values({
    actorId: input.actorId,
    systemAction: input.actorId === null,
    actionType: input.action,
    targetType: auditOperations[input.action].targetType,
    targetId: input.targetId,
    beforeState: allowedState(input.action, "before", input.before),
    afterState: allowedState(input.action, "after", input.after),
    publicReason: reason ?? null,
    createdAt: input.at,
  }).returning({ id: auditLogs.id });
  return saved.id;
}
