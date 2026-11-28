import { loadAuditLog } from "@/admin/audit-logs";
import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, parseQuery, uuid } from "@/api/request";
import { readAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ logId: string }>;
}>("school", {
  async GET(request, context, viewer) {
    const { logId } = parsePathParams(await context.params, { logId: uuid });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    const data = await readAdmin(db, viewer.userId, (reader, current) => loadAuditLog(reader, current, logId), "school");
    return { data };
  },
});
