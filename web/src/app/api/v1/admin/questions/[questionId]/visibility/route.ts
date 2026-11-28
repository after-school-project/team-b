import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { changeQaVisibility, qaVisibilitySchema } from "@/qa/admin-mutations";

export const runtime = "nodejs";

/** API-AQ-01 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ questionId: string }>;
}>("any", {
  async POST(request, context, viewer, mutation) {
    const { questionId } = parsePathParams(await context.params, { questionId: uuid });
    const input = await readJson(request, qaVisibilitySchema);
    const { db } = await import("@/db/client");
    return changeQaVisibility(db, viewer.userId, { type: "question", id: questionId }, input, mutation);
  },
});
