import type { ScreenSearchParams } from "@/auth/screen";

export type NotificationState = "all" | "unread";

/** 絞り込みの選択肢。API の state の値と、画面のURL（「すべて」はクエリーなし）。 */
export const notificationStates: readonly { value: NotificationState; label: string; href: string }[] = [
  { value: "all", label: "すべて", href: "/notifications" },
  { value: "unread", label: "未読のみ", href: "/notifications?state=unread" },
];

/**
 * 画面のクエリーから、絞り込み（未指定・空欄は all）とカーソルを取り出す。
 * 定義していない state の値と、同名の複数指定は形式の誤りとして扱う。ほかのクエリーは無視する。
 */
export function readNotificationParams(searchParams: ScreenSearchParams) {
  const query = new URLSearchParams();
  let malformed = false;
  for (const name of ["state", "cursor"] as const) {
    const raw = searchParams[name];
    if (Array.isArray(raw)) malformed = true;
    else if (raw !== undefined && raw.trim() !== "") query.set(name, raw);
  }
  const raw = query.get("state");
  if (raw !== null && raw !== "all" && raw !== "unread") malformed = true;
  // 既定値の all はURLに残さない。
  if (raw === "all") query.delete("state");
  const state: NotificationState = raw === "unread" ? "unread" : "all";
  return { state, query, malformed };
}
