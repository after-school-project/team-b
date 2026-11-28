import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AccessReader, Viewer } from "@/auth/access";
import { requireAdmin } from "@/auth/admin";
import { eventRequests, eventRevisions, events } from "@/db/content-schema";
import { reportCases } from "@/db/moderation-schema";
import { eventEffectiveEndSql } from "@/events/holding-state";
import { countPendingNoticeReviews } from "@/notices/admin";
import { caseSource, viewableCases } from "@/reports/case-access";

const publishedRevision = alias(eventRevisions, "published_event_revision");

export async function loadAdminDashboard(reader: AccessReader, viewer: Viewer) {
  requireAdmin(viewer, "any");
  const school = viewer.roles.schoolManager;
  const noticeRequests = await countPendingNoticeReviews(reader, viewer);
  const [eventCount] = await reader.select({ total: count() }).from(eventRequests)
    .innerJoin(events, eq(events.id, eventRequests.eventId))
    .innerJoin(eventRevisions, eq(eventRevisions.id, eventRequests.revisionId))
    .leftJoin(publishedRevision, and(eq(publishedRevision.id, events.publicRevisionId), eq(publishedRevision.eventId, events.id)))
    .where(and(eq(eventRequests.status, "pending"), ne(events.originKind, "staff"),
      ne(events.authorId, viewer.userId), isNull(events.cancelledAt),
      or(
        and(eq(eventRequests.requestKind, "new"), isNull(events.publicRevisionId), sql`
          (${eventRevisions.startsAt} AT TIME ZONE 'Asia/Tokyo')::date >= (now() AT TIME ZONE 'Asia/Tokyo')::date
        `),
        and(eq(eventRequests.requestKind, "edit"), sql`${eventEffectiveEndSql(publishedRevision)} > now()`),
      )));
  const [reportCount] = await reader.select({ total: count() })
    .from(caseSource(reader).where(and(eq(reportCases.status, "unhandled"), viewableCases(viewer))).as("unhandled_cases"));

  return {
    counts: { noticeRequests, eventRequests: eventCount.total, unhandledReports: reportCount.total },
    navigation: {
      canViewNotices: true, canViewEvents: true, canViewReports: true, canViewUsers: true,
      canViewGraduation: school, canViewAuditLogs: school, canViewProfileReviews: true, canViewHandoffs: school,
    },
  };
}
