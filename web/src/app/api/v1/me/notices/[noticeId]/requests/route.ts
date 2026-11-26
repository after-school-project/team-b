import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, uuid } from "@/api/request";
import { listMyNoticeRequests, parseRequestQuery } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ noticeId: string }>;
}>({
  async GET(request, context, viewer) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    const query = parseRequestQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const result = await listMyNoticeRequests(db, viewer, noticeId, query);
    return { data: result.data, page: result.page };
  },
});
