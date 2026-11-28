import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { changeQaVisibility, qaVisibilitySchema } from "@/qa/admin-mutations";

export const runtime = "nodejs";

/** API-AQ-02 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ responseId: string }>;
}>("any", {
  async POST(request, context, viewer, mutation) {
    const { responseId } = parsePathParams(await context.params, { responseId: uuid });
    const input = await readJson(request, qaVisibilitySchema);
    const { db } = await import("@/db/client");
    return changeQaVisibility(db, viewer.userId, { type: "response", id: responseId }, input, mutation);
  },
});
