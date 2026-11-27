import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { deleteQuestion, qaDeletionSchema } from "@/qa/question-mutations";

export const runtime = "nodejs";

/**
 * API-QA-06：質問の本人削除（QA-02）。プロフィール非表示中も利用できる。回答等は連鎖削除しない。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ questionId: string }>;
}>({
  async POST(request, context, viewer, input) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    parseQuery(new URL(request.url), {});
    const body = await readJson(request, qaDeletionSchema);
    const { db } = await import("@/db/client");
    return deleteQuestion(db, viewer.userId, input, questionId, body);
  },
});
