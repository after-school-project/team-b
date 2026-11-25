import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadProfileReview } from "@/profile/profile-reviews";

export const runtime = "nodejs";

/**
 * API-PR-02：プロフィール再公開審査の詳細（AD-15）。公開予定の項目だけを返す。取得できない申請は404。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ reviewId: string }>;
}>("any", {
  async GET(request, context, viewer) {
    const { reviewId } = parsePathParams(await context.params, { reviewId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadProfileReview(db, viewer, reviewId) };
  },
});
