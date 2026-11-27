import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, uuid } from "@/api/request";
import { loadAdminNoticeRequest } from "@/notices/admin";

export const runtime = "nodejs";

/** API-AN-02 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ requestId: string }>;
}>("any", {
  async GET(_request, context, viewer) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    const { db } = await import("@/db/client");
    return { data: await loadAdminNoticeRequest(db, viewer, requestId) };
  },
});
