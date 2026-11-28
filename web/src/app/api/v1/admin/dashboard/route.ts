import { loadAdminDashboard } from "@/admin/dashboard";
import { defineAdminApiRoute } from "@/api/admin-route";
import { parseQuery } from "@/api/request";
import { readAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    const data = await readAdmin(db, viewer.userId, (reader, current) => loadAdminDashboard(reader, current));
    return { data };
  },
});
