import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parseMyNoticeQuery, searchMyNotices } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseMyNoticeQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const result = await searchMyNotices(db, viewer, query);
    return { data: result.data, page: result.page };
  },
});
