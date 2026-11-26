import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parseQuestionQuery, searchQuestions } from "@/qa/questions";

export const runtime = "nodejs";

/**
 * API-QA-02：Q&A一覧・検索（QA-01）。停止していない利用者が利用できる。
 * 公開中・未削除の質問だけを、作成日時の降順で返す。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseQuestionQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return searchQuestions(db, viewer, query);
  },
});
