import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { listNotifications, parseNotificationQuery } from "@/notifications/notifications";

export const runtime = "nodejs";

/**
 * API-NT-01：通知一覧（GE-06）。停止していない受信者本人が利用できる。
 * 本人の通知だけを作成日時の降順で返す。取得しただけでは既読にしない。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseNotificationQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return listNotifications(db, viewer, query);
  },
});
