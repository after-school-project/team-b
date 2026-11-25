import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parseQuery } from "@/api/request";
import { listQuestionCategories } from "@/qa/questions";

export const runtime = "nodejs";

/**
 * API-QA-01：Q&Aのカテゴリー（QA-01・QA-03）。停止していない利用者が利用できる。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request) {
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: { items: await listQuestionCategories(db) } };
  },
});
