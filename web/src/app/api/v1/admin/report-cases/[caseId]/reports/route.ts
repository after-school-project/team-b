import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, uuid } from "@/api/request";
import { listCaseReports, parseCaseItems, readCases } from "@/reports/case-reads";

export const runtime = "nodejs";

type Context = { params: Promise<{ caseId: string }> };

/** API-RP-07 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<Context>("any", {
  async GET(request, { params }, viewer) {
    const { caseId } = parsePathParams(await params, { caseId: uuid });
    const query = parseCaseItems(new URL(request.url));
    const { db } = await import("@/db/client");
    return readCases(db, viewer.userId, (reader, current) => listCaseReports(reader, current, caseId, query));
  },
});
