import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { loadCaseEvidence, readCases } from "@/reports/case-reads";

export const runtime = "nodejs";

type Context = { params: Promise<{ caseId: string; evidenceId: string }> };

/** API-RP-09 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<Context>("any", {
  async GET(request, { params }, viewer) {
    const { caseId, evidenceId } = parsePathParams(await params, { caseId: uuid, evidenceId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    return { data: await readCases(db, viewer.userId, (reader, current) => loadCaseEvidence(reader, current, caseId, evidenceId)) };
  },
});
