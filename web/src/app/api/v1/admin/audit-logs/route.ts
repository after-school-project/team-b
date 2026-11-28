import { listAuditLogs, parseAuditLogs } from "@/admin/audit-logs";
import { defineAdminApiRoute } from "@/api/admin-route";
import { readAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("school", {
  async GET(request, _context, viewer) {
    const query = parseAuditLogs(new URL(request.url));
    const { db } = await import("@/db/client");
    return readAdmin(db, viewer.userId, (reader, current) => listAuditLogs(reader, current, query), "school");
  },
});
