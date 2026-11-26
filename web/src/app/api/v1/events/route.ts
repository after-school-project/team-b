import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { listEvents, parseEventQuery } from "@/events/event-list";

export const runtime = "nodejs";

/** API-EV-01：利用資格のあるメンバー向けの公開イベント一覧。 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    const query = parseEventQuery(new URL(request.url));
    const { db } = await import("@/db/client");
    const referenceTime = new Date();
    return db.transaction((tx) => listEvents(tx, viewer, query, referenceTime), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  },
});
