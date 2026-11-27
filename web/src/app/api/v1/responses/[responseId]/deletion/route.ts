import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { qaDeletionSchema } from "@/qa/question-mutations";
import { deleteResponse } from "@/qa/response-mutations";

export const runtime = "nodejs";

/**
 * API-QA-11：回答・コメント・返信の本人削除（QA-02）。プロフィール非表示中も利用できる。子の投稿は連鎖削除しない。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ responseId: string }>;
}>({
  async POST(request, context, viewer, input) {
    const { responseId } = parsePathParams(await context.params, { responseId: uuid });
    parseQuery(new URL(request.url), {});
    const body = await readJson(request, qaDeletionSchema);
    const { db } = await import("@/db/client");
    return deleteResponse(db, viewer.userId, input, responseId, body);
  },
});
