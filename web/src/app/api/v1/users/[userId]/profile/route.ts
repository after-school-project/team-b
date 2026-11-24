import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, userId as userIdSchema } from "@/api/request";
import { loadUserProfile } from "@/profile/public-profile";

export const runtime = "nodejs";

/**
 * API-PRO-03：利用者の公開プロフィール（GE-03）。停止していない利用者が利用できる。
 * 公開中なら公開を許可された項目だけを、非表示中なら状態案内だけを返す。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ userId: string }>;
}>({
  async GET(request, context, viewer) {
    const { userId } = parsePathParams(await context.params, { userId: userIdSchema });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadUserProfile(db, viewer, userId) };
  },
});
