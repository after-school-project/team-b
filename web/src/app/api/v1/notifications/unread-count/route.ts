import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parseQuery } from "@/api/request";
import { countUnreadNotifications } from "@/notifications/notifications";

export const runtime = "nodejs";

/**
 * API-NT-02：通知の未読件数（GE-01・GE-06）。停止していない受信者本人が利用できる。
 * 一覧と同じく本人の通知だけを数える。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: { count: await countUnreadNotifications(db, viewer) } };
  },
});
