import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { events, notices, qaQuestions, qaResponses } from "@/db/content-schema";
import { communityUsers, type profileRevisions } from "@/db/schema";

/**
 * 公開範囲・対象状態による取得条件と返却項目の共通処理（Issue #7 ④、共通認可条件表 §2・§3）。
 *
 * - 取得条件はSQLの条件として返す。一覧・詳細・件数・検索候補に同じ条件を使い、
 *   権限外のデータを先に取得・集計してから取り除く実装をしない（API設計書 §3）。
 * - 返却項目は、サーバーで絞った値だけをDTOへ入れる。非公開値をブラウザーへ送って表示だけを隠さない。
 * - 条件は一般の閲覧者向けの公開状態だけを表す。本人・管理者向けの取得、親投稿の扱い、
 *   所属による投稿可否などの機能ごとの条件は、各機能でこの条件と組み合わせて判定する。
 */

function every(...conditions: SQL[]): SQL {
  return and(...conditions)!;
}

/** 一般の閲覧者に表示できるQ&Aの質問。強制非表示・削除済みを除く。 */
export function visibleQuestion(): SQL {
  return every(isNull(qaQuestions.forcedHiddenAt), isNull(qaQuestions.deletedAt));
}

/**
 * 一般の閲覧者に表示できるQ&Aの回答・コメント・返信。強制非表示・削除済みを除く。
 * 親質問が削除されても、残存する回答等は表示できる（QA-05）。親の状態は Q&A 機能で判定する。
 */
export function visibleResponse(): SQL {
  return every(isNull(qaResponses.forcedHiddenAt), isNull(qaResponses.deletedAt));
}

/**
 * 一般の閲覧者に表示できるお知らせ。公開版があり、強制非表示・削除済みでないもの。
 * 本文は `notices.publicRevisionId` の版から取得する。編集審査中の版（未承認版）は返さない。
 */
export function publishedNotice(): SQL {
  return every(isNotNull(notices.publicRevisionId), isNull(notices.forcedHiddenAt), isNull(notices.deletedAt));
}

/**
 * 一般の閲覧者に表示できるイベント。公開版があり、強制非表示でないもの。終了・中止したイベントも含む（EV-11）。
 * 本文は `events.publicRevisionId` の版から取得する。審査中の版（未承認版）は返さない。
 */
export function publishedEvent(): SQL {
  return every(isNotNull(events.publicRevisionId), isNull(events.forcedHiddenAt));
}

/** 削除済みお知らせの本文を取得できる期間（日）。DB・ER設計書 §7。 */
export const deletedNoticeRetentionDays = 180;

/**
 * 削除済みお知らせのうち、本文を取得できる期間内のもの。期限到来後は本人・学校管理者・申請履歴経由を含めて本文を返さない。
 * 取得できる利用者（本人または学校管理者）の判定は、お知らせ機能でこの条件と組み合わせる。
 * 基準時刻を省略した場合はDBの現在時刻を使う。更新ではロック取得後の時刻（`commitMutation` の `now`）を渡す。
 */
export function retainedDeletedNotice(now?: Date): SQL {
  const current = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  return every(
    isNotNull(notices.deletedAt),
    sql`${notices.deletedAt} > ${current} - make_interval(days => ${deletedNoticeRetentionDays})`,
  );
}

/**
 * 他人のプロフィールを表示できる利用者。プロフィール公開中のもの（GE-03・GE-04）。
 * 非表示中は状態案内だけを返し、プロフィール情報を返さない。
 */
export function publicProfileState(): SQL {
  return eq(communityUsers.profileState, "public");
}

type ProfileRevision = typeof profileRevisions.$inferSelect;
export type OptionalProfileField = keyof ProfileRevision["optionalValues"];
type ProfileVisibility = NonNullable<ProfileRevision["fieldVisibility"][OptionalProfileField]>;

/** プロフィールの任意項目。保存値に未知のキーがあっても、この項目だけを返す。 */
export const optionalProfileFields = ["bio", "occupation", "interests"] as const satisfies readonly OptionalProfileField[];

export type OptionalProfileFieldView = { value?: string; visibility: ProfileVisibility };

/** プロフィールを見る相手。`owner` は本人、`member` は本人以外の閲覧者（管理者の再公開審査を含む）。 */
export type ProfileAudience = "owner" | "member";

/**
 * プロフィールの任意項目を、見る相手に応じて絞る（API設計書 ProfileFields）。
 * - 本人には全項目を返す。公開範囲が未設定の項目は `self`（本人のみ）として扱う。
 * - 本人以外には `members` の項目だけを返し、本人のみの項目はキーごと省略する。
 */
export function projectOptionalProfileFields(
  revision: Pick<ProfileRevision, "optionalValues" | "fieldVisibility">,
  audience: ProfileAudience,
): Partial<Record<OptionalProfileField, OptionalProfileFieldView>> {
  const projected: Partial<Record<OptionalProfileField, OptionalProfileFieldView>> = {};
  for (const field of optionalProfileFields) {
    const value = revision.optionalValues[field];
    const stored = revision.fieldVisibility[field];
    const visibility: ProfileVisibility = stored === "members" ? "members" : "self";
    if (audience === "member" && visibility !== "members") continue;
    if (value === undefined && stored === undefined) continue;
    projected[field] = value === undefined ? { visibility } : { value, visibility };
  }
  return projected;
}
