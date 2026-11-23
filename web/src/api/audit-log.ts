import { auditLogs } from "../db/moderation-schema";
import type { RecordWriter } from "./notifications";

/**
 * 監査ログの記録（Issue #47 ②）。業務更新と同じトランザクションで呼ぶ。
 *
 * before/after に入れてよい項目を操作ごとの許可リストで制限し、秘密値・ハッシュ・セッショントークン・投稿本文・
 * 本人確認情報・本人のみの任意プロフィール項目をコピーしない（DB・ER設計書 §5、API設計書 §14）。
 * 値は状態・所属・権限フラグなどの単純な値（文字列・数値・真偽値・null）に限る。
 *
 * 許可リストには、このIssueで #8 が使う操作を定める。その他の操作は、その操作を実装する各機能Issueで追加する。
 * 監査ログの閲覧（API-LOG-01・02）は #16 で実装する。
 */

type AuditValue = string | number | boolean | null;

/** 操作ごとの対象の種類と、before/after に入れてよい項目。 */
export const auditOperations = {
  /** プロフィールの非表示（API-US-05）。対象は利用者。publicReason に本人向け理由を記録する。 */
  "profile.hidden": { targetType: "user", fields: ["profileState"] },
  /** 再公開審査の承認（API-PR-03）。対象は審査。 */
  "profile_review.approved": { targetType: "profile_review", fields: ["status", "profileState", "version"] },
  /** 再公開審査の却下（API-PR-03）。対象は審査。publicReason に却下理由を記録する。 */
  "profile_review.rejected": { targetType: "profile_review", fields: ["status", "profileState", "version"] },
  /** 卒業区分の一括変更（API-GR-02）。対象者ごとに1件記録する。 */
  "graduation.graduated": { targetType: "user", fields: ["baseRole", "isGraduating", "version", "batchId"] },
  /** 卒業区分の誤変更修正（API-GR-03）。 */
  "graduation.corrected": { targetType: "user", fields: ["baseRole", "isGraduating", "version", "batchId"] },
} as const satisfies Record<string, { targetType: string; fields: readonly string[] }>;

export type AuditAction = keyof typeof auditOperations;
type AuditState<A extends AuditAction> = Partial<Record<(typeof auditOperations)[A]["fields"][number], AuditValue>>;

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

function allowedState(action: AuditAction, state: Record<string, unknown> | undefined): Record<string, AuditValue> | null {
  if (state === undefined) return null;
  const fields: readonly string[] = auditOperations[action].fields;
  const result: Record<string, AuditValue> = {};
  for (const [key, value] of Object.entries(state)) {
    // 型チェックを経由しない呼び出し（スプレッドした行など）でも、許可外の項目を保存しない。
    if (!fields.includes(key)) throw new Error(`監査ログ ${action} に許可されていない項目です：${key}`);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`監査ログ ${action} の ${key} には単純な値だけを記録できます。`);
    }
    if (value !== undefined) result[key] = value as AuditValue;
  }
  return result;
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
    beforeState: allowedState(input.action, input.before),
    afterState: allowedState(input.action, input.after),
    publicReason: reason ?? null,
    createdAt: input.at,
  }).returning({ id: auditLogs.id });
  return saved.id;
}
