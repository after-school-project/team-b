import { defineAdminApiRoute } from "@/api/admin-route";
import { listCases, parseCaseList, readCases } from "@/reports/case-reads";

export const runtime = "nodejs";

/** API-RP-01 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    const query = parseCaseList(new URL(request.url));
    const { db } = await import("@/db/client");
    return readCases(db, viewer.userId, (reader, current) => listCases(reader, current, query));
  },
});
