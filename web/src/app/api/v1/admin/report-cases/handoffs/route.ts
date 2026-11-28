import { defineAdminApiRoute } from "@/api/admin-route";
import { listCases, parseCaseList, readCases } from "@/reports/case-reads";

export const runtime = "nodejs";

/** API-RP-10 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("school", {
  async GET(request, _context, viewer) {
    const query = parseCaseList(new URL(request.url), true);
    const { db } = await import("@/db/client");
    return readCases(db, viewer.userId, (reader, current) => listCases(reader, current, query, true), "school");
  },
});
