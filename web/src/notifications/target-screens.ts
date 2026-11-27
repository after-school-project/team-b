import type { NotificationKind } from "@/api/notifications";
import { implementedScreenRoutes } from "@/auth/return-to";

/**
 * 通知の種類ごとの遷移先の画面のルート（画面遷移設計書 §2）。サーバーとブラウザーの両方から使うため、DBを読み込まない。
 *
 * 遷移先の画面が実装済みかは、共通ナビ・戻り先の許可と同じ「実装済みの画面」の一覧（`implementedScreenRoutes`）で判定する。
 * 画面を実装する Issue でその一覧へルートを追加すれば、通知からの遷移も同時に有効になる。
 */
export const targetScreenRoutes = {
  qa_answer_created: "/questions/[questionId]",
  qa_comment_created: "/questions/[questionId]",
  qa_reply_created: "/questions/[questionId]",
  qa_hidden: "/questions/[questionId]",
  notice_review_requested: "/admin/notices/[noticeId]",
  notice_review_decided: "/me/notices",
  event_review_requested: "/admin/events/[eventId]",
  event_review_decided: "/me/events",
  profile_review_decided: "/me/profile",
  profile_hidden: "/me/profile",
} as const satisfies Record<NotificationKind, string>;

/** 通知の種類の遷移先の画面が実装済みか。 */
export function isTargetScreenImplemented(kind: NotificationKind): boolean {
  return implementedScreenRoutes.includes(targetScreenRoutes[kind]);
}
