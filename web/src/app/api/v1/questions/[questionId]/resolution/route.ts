import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { questionResolutionSchema, updateQuestionResolution } from "@/qa/question-mutations";

export const runtime = "nodejs";

/**
 * API-QA-12：質問の解決状態の変更（QA-02）。質問者本人・プロフィール公開中・未削除の質問だけ。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ questionId: string }>;
}>({
  async PATCH(request, context, viewer, input) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    parseQuery(new URL(request.url), {});
    const body = await readJson(request, questionResolutionSchema);
    const { db } = await import("@/db/client");
    return updateQuestionResolution(db, viewer.userId, input, questionId, body);
  },
});
