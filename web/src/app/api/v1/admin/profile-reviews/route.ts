import { defineAdminApiRoute } from "@/api/admin-route";
import { listProfileReviews, parseProfileReviewQuery } from "@/profile/profile-reviews";

export const runtime = "nodejs";

/**
 * API-PR-01：プロフィール再公開審査の一覧（AD-15）。有効な両管理者が、審査できる申請だけを取得する。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    const query = parseProfileReviewQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const { data, page } = await listProfileReviews(db, viewer, query);
    return { data: { items: data.items.map(({ review }) => review) }, page };
  },
});
