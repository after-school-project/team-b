import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { deleteNotice } from "@/notices/mutations";
import { deletionInput } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ noticeId: string }>;
}>({
  async POST(request, context, viewer, mutation) {
    const { noticeId } = parsePathParams(await context.params, { noticeId: uuid });
    const body = await readJson(request, deletionInput);
    const { db } = await import("@/db/client");
    return deleteNotice(db, viewer, noticeId, body, mutation);
  },
});
