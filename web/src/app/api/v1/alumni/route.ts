import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parseAlumniQuery, searchAlumni } from "@/profile/public-profile";

export const runtime = "nodejs";

/**
 * API-PRO-04：卒業生検索（GE-04）。停止していない利用者が利用できる。
 * 掲載希望あり・公開中の卒業生と卒業予定の在校生だけを、公開表示名の昇順で返す。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseAlumniQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return searchAlumni(db, viewer, query);
  },
});
