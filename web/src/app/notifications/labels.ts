import type { NotificationKind } from "@/api/notifications";
import type { TargetState } from "@/notifications/targets";

/** 通知の種類の表示ラベル。対象の機能ごとにまとめる。 */
export const kindLabels: Record<NotificationKind, string> = {
  qa_answer_created: "Q&A",
  qa_comment_created: "Q&A",
  qa_reply_created: "Q&A",
  qa_hidden: "Q&A",
  notice_review_requested: "お知らせ",
  notice_review_decided: "お知らせ",
  event_review_requested: "イベント",
  event_review_decided: "イベント",
  profile_review_decided: "プロフィール",
  profile_hidden: "プロフィール",
};

/**
 * 遷移できない通知の対象の状態案内（画面遷移設計書 §4）。対象の題名・本文は表示しない。
 * not_available は、通知の文面が既に汎用の案内文になっているため、追加の案内を出さない。
 */
export const targetStateNotes: Record<Exclude<TargetState, "available">, string | null> = {
  withdrawn: "この申請は取り下げられたため、内容を表示できません。",
  deleted: "通知の対象は削除されました。",
  hidden: "通知の対象は非表示になっています。",
  expired: "通知の対象は保存期間が終了したため、表示できません。",
  not_available: null,
};

/**
 * API-NT-04 が返した遷移先が、同一アプリの相対パスか。`/` で始まり、`//`・`/\` で始まらないパスだけを許可する。
 * サーバーで組み立てたパスだけを返す契約だが、画面でも外部への遷移を防ぐ。
 */
export function isAppPath(path: unknown): path is string {
  return typeof path === "string" && /^\/(?![/\\])/.test(path);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" })
    .format(new Date(value));
}

/**
 * 通知の文面を、1行目の定型文と、2行目以降（本人向けの理由など）に分ける。
 * 文面はテキストとして表示し、HTMLとして解釈しない。
 */
export function splitMessage(message: string): { summary: string; detail: string | null } {
  const index = message.indexOf("\n");
  if (index < 0) return { summary: message, detail: null };
  const detail = message.slice(index + 1);
  return { summary: message.slice(0, index), detail: detail.trim() === "" ? null : detail };
}
