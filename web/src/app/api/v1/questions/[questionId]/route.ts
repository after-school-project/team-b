import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadQuestion } from "@/qa/questions";

export const runtime = "nodejs";

/**
 * API-QA-04：質問の詳細（QA-02）。停止していない利用者が利用できる。
 * 削除済み・閲覧できない強制非表示の質問は、本文などを含めず状態だけを返す。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ questionId: string }>;
}>({
  async GET(request, context, viewer) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadQuestion(db, viewer, questionId) };
  },
});
