import type { NotificationKind } from "@/api/notifications";
import { isTargetScreenImplemented } from "@/notifications/target-screens";
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
 * 「対象を表示する」を押したときに状態が変わっていた場合の案内にも使う。
 */
export const targetStateNotes: Record<Exclude<TargetState, "available">, string> = {
  withdrawn: "この通知の申請は取り下げられたため、内容を表示できません。",
  deleted: "通知の対象は削除されました。",
  hidden: "通知の対象は非表示になっています。",
  expired: "この通知の対象は保存期間が終了したため、表示できません。",
  not_available: "この通知の対象は、現在の権限では表示できません。",
};

/**
 * サーバーが保存した文面の代わりに状態案内を通知の文面として返す状態（`stateOnlyMessages`）。
 * 一覧では文面が既に状態案内になっているため、同じ案内を重ねて表示しない。
 */
const stateOnlyStates: ReadonlySet<TargetState> = new Set(["not_available", "withdrawn", "expired"]);

/** 遷移先の画面がまだない通知に表示する案内。 */
export const pendingScreenNote = "この通知の遷移先の画面は準備中です。";

/**
 * 一覧の通知に「対象を表示する」を出すか。対象へ遷移でき、遷移先の画面が実装済みのものだけ。
 * 画面がない遷移先はサーバーが not_available にするが、画面でも同じ一覧（`implementedScreenRoutes`）で確かめる。
 */
export function canOpenTarget(kind: NotificationKind, state: TargetState): boolean {
  return state === "available" && isTargetScreenImplemented(kind);
}

/**
 * 一覧の通知に、文面とは別に表示する状態案内。表示しない場合は null。
 * 準備中の案内は、閲覧者に対象を見る資格があり、遷移先の画面だけがない通知（サーバーが判定した `screenPending`）に限る。
 * 同じ種類でも、資格を失った通知には出さない。画面を公開すれば開けるように見せないため。
 */
export function listedTargetNote(state: TargetState, screenPending: boolean): string | null {
  if (screenPending) return pendingScreenNote;
  if (state === "available" || stateOnlyStates.has(state)) return null;
  return targetStateNotes[state];
}

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
