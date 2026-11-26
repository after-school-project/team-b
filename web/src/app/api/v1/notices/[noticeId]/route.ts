import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadPublicNotice } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ noticeId: string }>;
}>({
  async GET(request, context) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await loadPublicNotice(db, noticeId) };
  },
});
