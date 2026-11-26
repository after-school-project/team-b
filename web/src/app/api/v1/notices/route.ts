import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { readJson } from "@/api/request";
import { createNotice } from "@/notices/mutations";
import { createNoticeInput, parsePublicNoticeQuery, searchNotices } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parsePublicNoticeQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const result = await searchNotices(db, viewer, query);
    return { data: result.data, page: result.page };
  },
  async POST(request, _context, viewer, mutation) {
    const body = await readJson(request, createNoticeInput);
    const { db } = await import("@/db/client");
    return createNotice(db, viewer, body, mutation);
  },
});
