import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { withdrawNoticeRequest } from "@/notices/mutations";
import { withdrawalInput } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ requestId: string }>;
}>({
  async POST(request, context, viewer, mutation) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    const body = await readJson(request, withdrawalInput);
    const { db } = await import("@/db/client");
    return withdrawNoticeRequest(db, viewer, requestId, body, mutation);
  },
});
