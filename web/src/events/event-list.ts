import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { containing, searchText } from "@/api/list-filters";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import type { AccessReader, Viewer } from "@/auth/access";
import { publishedEvent } from "@/auth/visibility";
import { eventRevisions, events } from "@/db/content-schema";
import { eventExactEndsAt, eventHoldingStateSql, resolveEventHoldingState, type HoldingState } from "./holding-state";

export type EventListItem = {
  id: string;
  title: string;
  startsAt: string;
  effectiveEndsAt: string;
  format: (typeof eventRevisions.$inferSelect)["format"];
  holdingState: HoldingState;
  originKind: (typeof events.$inferSelect)["originKind"];
  createdAt: string;
};

export function parseEventQuery(url: URL) {
  return parseListQuery(url, {
    q: searchText.optional(),
    state: z.enum(["all", "scheduled", "ended", "cancelled"]).default("all"),
    sort: z.enum(["created_desc", "starts_asc"]).default("created_desc"),
  });
}

const cursorPosition = z.tuple([z.string(), z.string()]);
const publicRevision = and(eq(eventRevisions.eventId, events.id), eq(eventRevisions.id, events.publicRevisionId));

/** API-EV-01。行と件数は同一スナップショットの公開版から取得する。 */
export async function listEvents(
  reader: AccessReader,
  viewer: Viewer,
  query: ReturnType<typeof parseEventQuery>,
  referenceTime: Date,
) {
  const { q, state, sort, limit, cursor } = query;
  const codec = createCursorCodec({ actorId: viewer.userId, list: "events", filters: { q, state }, sort }, cursorPosition);
  const last = codec.decode(cursor);
  const byStart = sort === "starts_asc";
  const timestamp = byStart ? eventRevisions.startsAt : events.createdAt;
  const order = byStart ? asc : desc;
  const pattern = q === undefined ? undefined : containing(q);

  return queryListPage({
    authorized: publishedEvent(),
    filters: and(
      pattern === undefined ? undefined : or(ilike(eventRevisions.title, pattern), ilike(eventRevisions.description, pattern)),
      state === "all" ? undefined : eq(eventHoldingStateSql(referenceTime), state),
    ),
    after: last
      ? sql`(${timestamp}, ${events.id}) ${byStart ? sql`>` : sql`<`} (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: events.id,
      title: eventRevisions.title,
      startsAt: eventRevisions.startsAt,
      endsAt: eventRevisions.endsAt,
      exactEndsAt: eventExactEndsAt,
      format: eventRevisions.format,
      originKind: events.originKind,
      createdAt: events.createdAt,
      cancelledAt: events.cancelledAt,
      cursorAt: cursorTimestamp(timestamp),
    }).from(events).innerJoin(eventRevisions, publicRevision)
      .where(where).orderBy(order(timestamp), order(events.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(events)
        .innerJoin(eventRevisions, publicRevision).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): EventListItem => {
      const { holdingState, effectiveEndsAt } = resolveEventHoldingState(
        { ...row, endsAtHasSubmillisecond: row.exactEndsAt !== null }, row.cancelledAt, referenceTime,
      );
      return {
        id: row.id,
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        effectiveEndsAt: row.exactEndsAt ?? effectiveEndsAt.toISOString(),
        format: row.format,
        holdingState,
        originKind: row.originKind,
        createdAt: row.createdAt.toISOString(),
      };
    },
  });
}
