import { loadAdminUser } from "@/admin/users";
import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, parseQuery, userId as userIdSchema } from "@/api/request";
import { readAdmin } from "@/auth/admin";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ userId: string }>;
}>("any", {
  async GET(request, context, viewer) {
    const { userId } = parsePathParams(await context.params, { userId: userIdSchema });
    parseQuery(new URL(request.url), {});
    const { db } = await import("@/db/client");
    const data = await readAdmin(db, viewer.userId, (reader, current) => loadAdminUser(reader, current, userId));
    return { data };
  },
});
