import { and, asc, count, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { hasAdminScope, requireAdmin, type AdminScope } from "@/auth/admin";
import { noCapabilities } from "@/auth/capabilities";
import { publishedNotice, retainedDeletedNotice } from "@/auth/visibility";
import { noticeRequests, noticeRevisions, notices } from "@/db/content-schema";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";
import {
  authorView, noticeContentView, requestsForNotices, requestSummary, retentionExpiresAt,
  type ManagedContent, type ManagedNoticeListItem, type ReviewRequest,
} from "./notices";

export function parseAdminNoticeRequestQuery(url: URL) {
  return parseListQuery(url, {
    status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    kind: z.enum(["all", "new", "edit"]).default("all"),
  });
}

export function parseAdminNoticeQuery(url: URL) {
  return parseListQuery(url, { state: z.enum(["all", "public", "hidden", "deleted"]).default("all") });
}

const cursorPosition = z.tuple([z.string(), uuid]);

function reviewAccess(viewer: Viewer) {
  return and(
    eq(notices.originKind, "alumni"),
    ne(noticeRequests.status, "withdrawn"),
    viewer.roles.schoolManager ? or(isNull(notices.deletedAt), retainedDeletedNotice()) : isNull(notices.deletedAt),
  )!;
}

function canReview(viewer: Viewer, row: {
  request: typeof noticeRequests.$inferSelect;
  authorId: string;
  deletedAt: Date | null;
}) {
  return row.request.status === "pending" && row.deletedAt === null && viewer.userId !== row.authorId;
}

export async function countPendingNoticeReviews(reader: AccessReader, viewer: Viewer) {
  const [row] = await reader.select({ total: count() }).from(noticeRequests)
    .innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
    .where(and(eq(notices.originKind, "alumni"), eq(noticeRequests.status, "pending"),
      isNull(notices.deletedAt), ne(notices.authorId, viewer.userId), or(
        and(eq(noticeRequests.requestKind, "new"), isNull(notices.publicRevisionId)),
        and(eq(noticeRequests.requestKind, "edit"), isNotNull(notices.publicRevisionId)),
      )));
  return row.total;
}

export async function listAdminNoticeRequests(
  reader: AccessReader,
  viewer: Viewer,
  { status, kind, cursor, limit }: ReturnType<typeof parseAdminNoticeRequestQuery>,
) {
  requireAdmin(viewer, "any");
  const pending = status === "pending";
  const codec = createCursorCodec({
    actorId: viewer.userId, list: "admin/notice-requests", filters: { status, kind },
    sort: pending ? "submittedAt:asc,id:asc" : "submittedAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const order = pending ? asc : desc;
  return queryListPage({
    authorized: reviewAccess(viewer),
    filters: and(eq(noticeRequests.status, status), kind === "all" ? undefined : eq(noticeRequests.requestKind, kind)),
    after: last ? sql`(${noticeRequests.submittedAt}, ${noticeRequests.id}) ${sql.raw(pending ? ">" : "<")}
      (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
    limit,
    rows: (where, take) => reader.select({
      request: noticeRequests, authorId: notices.authorId, deletedAt: notices.deletedAt,
      title: noticeRevisions.title, cursorAt: cursorTimestamp(noticeRequests.submittedAt),
    }).from(noticeRequests)
      .innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
      .innerJoin(noticeRevisions, eq(noticeRevisions.id, noticeRequests.revisionId))
      .where(where).orderBy(order(noticeRequests.submittedAt), order(noticeRequests.id)).limit(take),
    count: async (where) => {
      const [row] = await reader.select({ total: count() }).from(noticeRequests)
        .innerJoin(notices, eq(notices.id, noticeRequests.noticeId)).where(where);
      return row.total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.request.id]),
    toItem: (row) => ({ request: { ...requestSummary(row.request), canReview: canReview(viewer, row) }, title: row.title }),
  });
}

export async function loadAdminNoticeRequest(
  reader: AccessReader, viewer: Viewer, requestId: string, noticeId?: string,
): Promise<ReviewRequest> {
  requireAdmin(viewer, "any");
  const [row] = await reader.select({
    request: noticeRequests, authorId: notices.authorId, deletedAt: notices.deletedAt,
    authorName: profileRevisions.displayName, authorProfileState: communityUsers.profileState,
    title: noticeRevisions.title, body: noticeRevisions.body, categoryCode: noticeRevisions.categoryCode,
  }).from(noticeRequests)
    .innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
    .innerJoin(noticeRevisions, eq(noticeRevisions.id, noticeRequests.revisionId))
    .innerJoin(communityUsers, eq(communityUsers.userId, notices.authorId))
    .innerJoin(profiles, eq(profiles.userId, notices.authorId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(reviewAccess(viewer), eq(noticeRequests.id, requestId),
      noticeId === undefined ? undefined : eq(notices.id, noticeId)));
  if (!row) throw new ApiError("NOT_FOUND");
  return {
    ...requestSummary(row.request),
    content: noticeContentView(row),
    applicant: authorView(row.authorId, row.authorName, row.authorProfileState),
    decisionReason: row.request.decisionReason,
    withdrawalReason: null,
    capabilities: { ...noCapabilities, canReview: canReview(viewer, row) },
  };
}

export function noticeVisibilityScope(originKind: "school" | "alumni"): AdminScope {
  return originKind === "school" ? "school" : "any";
}

export function managedNoticeAccess(viewer: Viewer, now?: Date) {
  return and(isNotNull(notices.publicRevisionId), or(
    publishedNotice(),
    and(isNull(notices.deletedAt), isNotNull(notices.forcedHiddenAt),
      viewer.roles.schoolManager ? undefined : eq(notices.originKind, "alumni")),
    viewer.roles.schoolManager ? retainedDeletedNotice(now) : undefined,
  ))!;
}

function noticeState(row: Pick<typeof notices.$inferSelect, "originKind" | "forcedHiddenAt" | "deletedAt">, viewer: Viewer) {
  const publicationState = row.deletedAt ? "deleted" : row.forcedHiddenAt ? "hidden" : "public";
  const canManage = hasAdminScope(viewer, noticeVisibilityScope(row.originKind));
  return {
    publicationState,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    retentionExpiresAt: retentionExpiresAt(row.deletedAt),
    capabilities: {
      ...noCapabilities,
      canHide: canManage && publicationState === "public",
      canRestore: canManage && publicationState === "hidden",
    },
  } as const;
}

export async function listAdminNotices(
  reader: AccessReader,
  viewer: Viewer,
  { state, cursor, limit }: ReturnType<typeof parseAdminNoticeQuery>,
) {
  requireAdmin(viewer, state === "deleted" ? "school" : "any");
  const filters = {
    all: undefined, public: publishedNotice(),
    hidden: and(isNull(notices.deletedAt), isNotNull(notices.forcedHiddenAt)),
    deleted: retainedDeletedNotice(),
  };
  const codec = createCursorCodec({
    actorId: viewer.userId, list: "admin/notices", filters: { state }, sort: "updatedAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const { data, page } = await queryListPage({
    authorized: managedNoticeAccess(viewer),
    filters: filters[state],
    after: last ? sql`(${notices.updatedAt}, ${notices.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
    limit,
    rows: (where, take) => reader.select({
      notice: notices, title: noticeRevisions.title, categoryCode: noticeRevisions.categoryCode,
      cursorAt: cursorTimestamp(notices.updatedAt),
    }).from(notices).innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
      .where(where).orderBy(desc(notices.updatedAt), desc(notices.id)).limit(take),
    count: async (where) => {
      const [row] = await reader.select({ total: count() }).from(notices).where(where);
      return row.total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.notice.id]),
    toItem: (row) => row,
  });
  const requests = await requestsForNotices(reader, data.items.filter(({ notice }) => !notice.deletedAt)
    .map(({ notice }) => notice.id), false);
  return {
    data: { items: data.items.map(({ notice, title, categoryCode }): ManagedNoticeListItem => {
      const requestSet = requests.get(notice.id);
      return {
        id: notice.id, version: notice.version, title, categoryCode, originKind: notice.originKind,
        ...noticeState(notice, viewer),
        pendingRequest: requestSet?.pending ? requestSummary(requestSet.pending) : null,
        latestRequestStatus: requestSet?.latest?.status ?? null,
        createdAt: notice.createdAt.toISOString(), updatedAt: notice.updatedAt.toISOString(),
      };
    }) },
    page,
  };
}

export async function loadAdminNotice(reader: AccessReader, viewer: Viewer, noticeId: string): Promise<ManagedContent> {
  requireAdmin(viewer, "any");
  const [row] = await reader.select({
    notice: notices, title: noticeRevisions.title, body: noticeRevisions.body, categoryCode: noticeRevisions.categoryCode,
    authorName: profileRevisions.displayName, authorProfileState: communityUsers.profileState,
  }).from(notices)
    .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
    .innerJoin(communityUsers, eq(communityUsers.userId, notices.authorId))
    .innerJoin(profiles, eq(profiles.userId, notices.authorId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(managedNoticeAccess(viewer), eq(notices.id, noticeId)));
  if (!row) throw new ApiError("NOT_FOUND");
  const { notice } = row;
  const content = noticeContentView(row);
  const pending = notice.deletedAt ? null : (await requestsForNotices(reader, [noticeId], false)).get(noticeId)?.pending;
  return {
    id: notice.id, version: notice.version, originKind: notice.originKind,
    author: authorView(notice.authorId, row.authorName, row.authorProfileState),
    ...noticeState(notice, viewer),
    publicContent: notice.deletedAt ? null : content,
    deletedContent: notice.deletedAt ? content : null,
    pendingRequest: pending ? requestSummary(pending) : null,
    holdingState: null,
  };
}
