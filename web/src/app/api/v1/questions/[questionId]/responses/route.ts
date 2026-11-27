import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { createResponse, responseCreateSchema } from "@/qa/response-mutations";
import { listResponses, parseResponseQuery } from "@/qa/responses";

export const runtime = "nodejs";

/**
 * API-QA-07：質問の回答・コメント・返信の一覧（QA-02）。停止していない利用者が利用できる。
 * API-QA-08：回答・コメント・返信の作成。プロフィール公開中の全所属の利用者が利用できる。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ questionId: string }>;
}>({
  async GET(request, context, viewer) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    const query = parseResponseQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return listResponses(db, viewer, questionId, query);
  },
  async POST(request, context, viewer, input) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    parseQuery(new URL(request.url), {});
    const body = await readJson(request, responseCreateSchema);
    const { db } = await import("@/db/client");
    return createResponse(db, viewer.userId, input, questionId, body);
  },
});
