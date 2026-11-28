import { listAdminUsers, parseAdminUsers } from "@/admin/users";
import { defineAdminApiRoute } from "@/api/admin-route";
import { readAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("any", {
  async GET(request, _context, viewer) {
    const query = parseAdminUsers(new URL(request.url));
    const { db } = await import("@/db/client");
    return readAdmin(db, viewer.userId, (reader, current) => listAdminUsers(reader, current, query));
  },
});
