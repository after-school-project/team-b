import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { decideNoticeRequest, noticeDecisionInput } from "@/notices/admin-mutations";

export const runtime = "nodejs";

/** API-AN-03 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ requestId: string }>;
}>("any", {
  async POST(request, context, viewer, input) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    const decision = await readJson(request, noticeDecisionInput);
    const { db } = await import("@/db/client");
    return decideNoticeRequest(db, viewer.userId, requestId, decision, input);
  },
});
