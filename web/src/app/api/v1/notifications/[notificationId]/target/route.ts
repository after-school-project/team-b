import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadNotificationTarget } from "@/notifications/notifications";

export const runtime = "nodejs";

/**
 * API-NT-04：通知の対象の遷移先（GE-06）。停止していない受信者本人が利用できる。他人の通知と存在しない通知は 404。
 * 対象を見る資格と対象の状態を現在の状態で判定し、`available` の場合だけ同一アプリの相対パスを返す。
 * 取得しただけでは既読にしない。遷移先の画面でも改めて認可する。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ notificationId: string }>;
}>({
  async GET(request, context, viewer) {
    const { notificationId } = parsePathParams(await context.params, { notificationId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadNotificationTarget(db, viewer, notificationId) };
  },
});
