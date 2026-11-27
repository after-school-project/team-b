import { defineAdminApiRoute } from "@/api/admin-route";
import { listAdminNotices, parseAdminNoticeQuery } from "@/notices/admin";

export const runtime = "nodejs";

/** API-AN-04 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    const query = parseAdminNoticeQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    return listAdminNotices(db, viewer, query);
  },
});
