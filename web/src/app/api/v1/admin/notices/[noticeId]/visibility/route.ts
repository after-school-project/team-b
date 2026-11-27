import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { changeNoticeVisibility, noticeVisibilityInput } from "@/notices/admin-mutations";

export const runtime = "nodejs";

/** API-AN-06 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ noticeId: string }>;
}>("any", {
  async POST(request, context, viewer, input) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    const change = await readJson(request, noticeVisibilityInput);
    const { db } = await import("@/db/client");
    return changeNoticeVisibility(db, viewer.userId, noticeId, change, input);
  },
});
