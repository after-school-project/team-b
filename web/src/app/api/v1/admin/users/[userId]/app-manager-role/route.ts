import { appManagerRoleSchema, changeAppManagerRole } from "@/admin/user-mutations";
import { defineAdminApiRoute } from "@/api/admin-route";
import { parsePathParams, readJson, userId as userIdSchema } from "@/api/request";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ userId: string }>;
}>("school", {
  async POST(request, context, viewer, input) {
    const { userId } = parsePathParams(await context.params, { userId: userIdSchema });
    const body = await readJson(request, appManagerRoleSchema);
    const { db } = await import("@/db/client");
    return changeAppManagerRole(db, { actorId: viewer.userId, userId, request: input, body });
  },
});
