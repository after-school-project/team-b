import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadMyNoticeRequest } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ requestId: string }>;
}>({
  async GET(request, context, viewer) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadMyNoticeRequest(db, viewer, requestId) };
  },
});
