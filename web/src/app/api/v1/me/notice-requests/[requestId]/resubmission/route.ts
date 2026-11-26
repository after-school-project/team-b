import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { resubmitNoticeRequest } from "@/notices/mutations";
import { resubmissionInput } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ requestId: string }>;
}>({
  async POST(request, context, viewer, mutation) {
    const { requestId } = parsePathParams(await context.params, { requestId: uuid });
    const body = await readJson(request, resubmissionInput);
    const { db } = await import("@/db/client");
    return resubmitNoticeRequest(db, viewer, requestId, body, mutation);
  },
});
