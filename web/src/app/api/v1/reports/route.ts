import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { readJson } from "@/api/request";
import { receiveReport, reportInputSchema } from "@/reports/receipt";

export const runtime = "nodejs";

/** API-MD-01 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async POST(request, _context, viewer, mutation) {
    const input = await readJson(request, reportInputSchema);
    const { db } = await import("@/db/client");
    return receiveReport(db, viewer.userId, input, mutation);
  },
});
