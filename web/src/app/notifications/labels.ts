import type { NotificationKind } from "@/api/notifications";

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
