import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { responsePatchSchema, updateResponse } from "@/qa/response-mutations";
import { loadResponse } from "@/qa/responses";

export const runtime = "nodejs";

/**
 * API-QA-09：回答・コメント・返信の1件（QA-02）。停止していない利用者が利用できる。
 * 削除済み・閲覧できない強制非表示の投稿は、本文などを含めず状態だけを返す。
 * API-QA-10：本人による本文の編集。投稿の種類・親・質問は変更できない。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ responseId: string }>;
}>({
  async GET(request, context, viewer) {
    const { responseId } = parsePathParams(await context.params, { responseId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadResponse(db, viewer, responseId) };
  },
  async PATCH(request, context, viewer, input) {
    const { responseId } = parsePathParams(await context.params, { responseId: uuid });
    parseQuery(new URL(request.url), {});
    const body = await readJson(request, responsePatchSchema);
    const { db } = await import("@/db/client");
    return updateResponse(db, viewer.userId, input, responseId, body);
  },
});
