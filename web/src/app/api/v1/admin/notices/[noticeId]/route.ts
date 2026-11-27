import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, uuid } from "@/api/request";
import { loadAdminNotice } from "@/notices/admin";

export const runtime = "nodejs";

/** API-AN-05 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ noticeId: string }>;
}>("any", {
  async GET(_request, context, viewer) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    const { db } = await import("@/db/client");
    return { data: await loadAdminNotice(db, viewer, noticeId) };
  },
});
