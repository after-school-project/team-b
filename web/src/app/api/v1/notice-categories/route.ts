import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { listNoticeCategories } from "@/notices/notices";

export const runtime = "nodejs";

export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET() {
    return { data: await listNoticeCategories() };
  },
});
