import { defineApiRoute } from "@/api/route";
import { parseQuery } from "@/api/request";
import { resolveMeState } from "@/auth/access";

export const runtime = "nodejs";

/** API-COM-01：ログイン中の本人の最新の利用状態。停止中も本人向け案内として200で返す。 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineApiRoute({
  async GET(request) {
    parseQuery(new URL(request.url), {});
    return { data: await resolveMeState(request.headers) };
  },
});
