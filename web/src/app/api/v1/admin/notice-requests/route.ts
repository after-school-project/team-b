import { defineAdminApiRoute } from "@/api/admin-route";
import { listAdminNoticeRequests, parseAdminNoticeRequestQuery } from "@/notices/admin";

export const runtime = "nodejs";

/** API-AN-01 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    const query = parseAdminNoticeRequestQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const { data, page } = await listAdminNoticeRequests(db, viewer, query);
    return { data: { items: data.items.map(({ request }) => request) }, page };
  },
});
