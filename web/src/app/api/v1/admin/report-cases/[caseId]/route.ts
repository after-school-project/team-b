import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, parseQuery, readJson, uuid } from "@/api/request";
import { casePatchSchema, changeReportCase } from "@/reports/case-mutations";
import { loadCase, readCases } from "@/reports/case-reads";

export const runtime = "nodejs";

type Context = { params: Promise<{ caseId: string }> };

/** API-RP-02・03 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<Context>("any", {
  async GET(request, { params }, viewer) {
    const { caseId } = parsePathParams(await params, { caseId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await readCases(db, viewer.userId, (reader, current) => loadCase(reader, current, caseId)) };
  },
  async PATCH(request, { params }, viewer, mutation) {
    const { caseId } = parsePathParams(await params, { caseId: uuid });
    const input = await readJson(request, casePatchSchema);
    const { db } = await import("@/db/client");
    return changeReportCase(db, viewer.userId, caseId, { kind: "patch", input }, mutation);
  },
});
