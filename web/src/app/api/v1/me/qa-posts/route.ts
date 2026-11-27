import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { listMyQaPosts, parseMyQaQuery } from "@/qa/my-posts";

export const runtime = "nodejs";

/**
 * API-QA-13：自分のQ&A投稿の一覧（GE-05）。本人の質問・回答・コメント・返信だけを返す。
 * プロフィール非表示中も、本人の既存投稿を確認できる。DBクライアントは要求時に読み込む。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseMyQaQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const result = await listMyQaPosts(db, viewer, query);
    return { data: result.data, page: result.page };
  },
});
