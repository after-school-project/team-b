import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { assignmentSchema, changeReportCase } from "@/reports/case-mutations";

export const runtime = "nodejs";

type Context = { params: Promise<{ caseId: string }> };

/** API-RP-04 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<Context>("any", {
  async POST(request, { params }, viewer, mutation) {
    const { caseId } = parsePathParams(await params, { caseId: uuid });
    const input = await readJson(request, assignmentSchema);
    const { db } = await import("@/db/client");
    return changeReportCase(db, viewer.userId, caseId, { kind: "assignment", input }, mutation);
  },
});
