import {
  and, count, desc, eq, exists, ilike, inArray, isNotNull, isNull, or, sql,
} from "drizzle-orm";
import { z } from "zod";
import { containing, searchText } from "@/api/list-filters";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { ApiError, type PageInfo } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { noCapabilities, type CapabilitySet } from "@/auth/capabilities";
import { isOwner } from "@/auth/ownership";
import { deletedNoticeRetentionDays, publishedNotice, retainedDeletedNotice } from "@/auth/visibility";
import { longText, title, uuid } from "@/api/request";
import { noticeRequests, noticeRevisions, notices } from "@/db/content-schema";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";
import { NOTICE_CATEGORY } from "./category";

export type NoticeContent = { title: string; body: string; categoryCode: "general" };
export type Category = { code: string; name: string };
export type PublicAuthor = { userId: string; displayName: string };
export type RequestSummary = {
  id: string;
  resourceId: string;
  kind: "new" | "edit";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  submittedAt: string;
  decidedAt: string | null;
  version: number;
  needsDateCorrection: boolean;
};
export type NoticeListItem = {
  id: string;
  title: string;
  category: Category;
  originKind: "school" | "alumni";
  author: PublicAuthor;
  firstPublishedAt: string;
  updatedAt: string;
};
export type PublicNotice = {
  id: string;
  content: NoticeContent;
  category: Category;
  originKind: "school" | "alumni";
  author: PublicAuthor;
  firstPublishedAt: string;
  updatedAt: string;
};
export type ManagedNoticeListItem = {
  id: string;
  version: number;
  title: string;
  categoryCode: string;
  originKind: "school" | "alumni";
  publicationState: "unpublished" | "public" | "hidden" | "deleted";
  pendingRequest: RequestSummary | null;
  latestRequestStatus: RequestSummary["status"] | null;
  deletedAt: string | null;
  retentionExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  capabilities: CapabilitySet;
};
export type ManagedContent = {
  id: string;
  version: number;
  originKind: "school" | "alumni";
  author: PublicAuthor;
  publicationState: ManagedNoticeListItem["publicationState"];
  publicContent: NoticeContent | null;
  pendingRequest: RequestSummary | null;
  deletedContent: NoticeContent | null;
  deletedAt: string | null;
  retentionExpiresAt: string | null;
  capabilities: CapabilitySet;
};
export type ReviewRequest = RequestSummary & {
  content: NoticeContent;
  applicant: PublicAuthor;
  decisionReason: string | null;
  withdrawalReason: string | null;
  capabilities: CapabilitySet;
};

const noticeContent = z.strictObject({
  title,
  body: longText,
  categoryCode: z.literal(NOTICE_CATEGORY.code),
});
export const createNoticeInput = noticeContent;
export const editNoticeInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  content: noticeContent,
});
export const withdrawalInput = z.strictObject({ expectedVersion: z.number().int().min(1) });
export const resubmissionInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  content: noticeContent,
});
export const deletionInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  confirmed: z.literal(true),
});

export const publicNoticeFilters = { q: searchText.optional() };
export const myNoticeFilters = {
  state: z.enum(["all", "pending", "public", "rejected", "withdrawn", "deleted"]).default("all"),
  sort: z.enum(["created_desc", "updated_desc"]).default("created_desc"),
};
export const requestFilters = {};

export function parsePublicNoticeQuery(url: URL) {
  return parseListQuery(url, publicNoticeFilters);
}

export function parseMyNoticeQuery(url: URL) {
  return parseListQuery(url, myNoticeFilters);
}

export function parseRequestQuery(url: URL) {
  return parseListQuery(url, requestFilters);
}

const publicCursorPosition = z.tuple([z.string(), uuid]);
const managedCursorPosition = z.tuple([z.string(), uuid]);
const requestCursorPosition = z.tuple([z.string(), uuid]);

function authorView(userId: string, displayName: string, profileState: "public" | "hidden"): PublicAuthor {
  return { userId, displayName: profileState === "public" ? displayName : "非公開ユーザー" };
}

function noticeContentView(revision: { title: string; body: string; categoryCode: string }): NoticeContent {
  if (revision.categoryCode !== NOTICE_CATEGORY.code) throw new Error("お知らせカテゴリーが不正です。");
  return { title: revision.title, body: revision.body, categoryCode: NOTICE_CATEGORY.code };
}

function requestSummary(row: typeof noticeRequests.$inferSelect): RequestSummary {
  return {
    id: row.id,
    resourceId: row.noticeId,
    kind: row.requestKind,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    version: row.version,
    needsDateCorrection: false,
  };
}

function retentionExpiresAt(deletedAt: Date | null): string | null {
  return deletedAt
    ? new Date(deletedAt.getTime() + deletedNoticeRetentionDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
}

function latestStatusCondition(status: "rejected" | "withdrawn") {
  return sql`(
    SELECT request.status FROM notice_requests AS request
    WHERE request.notice_id = ${notices.id}
    ORDER BY request.submitted_at DESC, request.id DESC
    LIMIT 1
  ) = ${status}`;
}

function hasRequest(reader: AccessReader, status?: "pending") {
  return exists(reader.select({ id: noticeRequests.id }).from(noticeRequests).where(and(
    eq(noticeRequests.noticeId, notices.id),
    status ? eq(noticeRequests.status, status) : undefined,
  )));
}

function stateCondition(reader: AccessReader, state: (typeof myNoticeFilters.state)["_output"]) {
  switch (state) {
    case "pending":
      return hasRequest(reader, "pending");
    case "public":
      return and(isNotNull(notices.publicRevisionId), isNull(notices.deletedAt));
    case "rejected":
      return and(isNull(notices.deletedAt), latestStatusCondition("rejected"));
    case "withdrawn":
      return and(isNull(notices.deletedAt), latestStatusCondition("withdrawn"));
    case "deleted":
      return retainedDeletedNotice();
    case "all":
      return or(
        and(isNull(notices.deletedAt), or(isNotNull(notices.publicRevisionId), hasRequest(reader))),
        retainedDeletedNotice(),
      );
  }
}

export async function listNoticeCategories(): Promise<{ items: Category[] }> {
  return { items: [NOTICE_CATEGORY] };
}

export async function searchNotices(
  reader: AccessReader,
  viewer: Viewer,
  query: ReturnType<typeof parsePublicNoticeQuery>,
) {
  const { q, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "notices",
    filters: { q },
    sort: "firstPublishedAt:desc,id:desc",
  }, publicCursorPosition);
  const last = codec.decode(cursor);
  const pattern = q === undefined ? undefined : containing(q);
  const filter = pattern === undefined ? undefined :
    or(ilike(noticeRevisions.title, pattern), ilike(noticeRevisions.body, pattern));

  return queryListPage({
    authorized: publishedNotice(),
    filters: filter,
    after: last
      ? sql`(${notices.firstPublishedAt}, ${notices.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: notices.id,
      title: noticeRevisions.title,
      categoryCode: noticeRevisions.categoryCode,
      originKind: notices.originKind,
      authorId: communityUsers.userId,
      authorName: profileRevisions.displayName,
      authorProfileState: communityUsers.profileState,
      firstPublishedAt: notices.firstPublishedAt,
      updatedAt: noticeRevisions.createdAt,
      cursorAt: cursorTimestamp(notices.firstPublishedAt),
    }).from(notices)
      .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
      .innerJoin(communityUsers, eq(communityUsers.userId, notices.authorId))
      .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
      .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
      .where(where)
      .orderBy(desc(notices.firstPublishedAt), desc(notices.id))
      .limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(notices)
        .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
        .where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): NoticeListItem => {
      if (!row.firstPublishedAt) throw new Error("公開日時のないお知らせが公開一覧に含まれました。");
      return {
        id: row.id,
        title: row.title,
        category: { code: row.categoryCode, name: NOTICE_CATEGORY.name },
        originKind: row.originKind,
        author: authorView(row.authorId, row.authorName, row.authorProfileState),
        firstPublishedAt: row.firstPublishedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  });
}

export async function loadPublicNotice(reader: AccessReader, noticeId: string): Promise<PublicNotice> {
  const [row] = await reader.select({
    id: notices.id,
    title: noticeRevisions.title,
    body: noticeRevisions.body,
    categoryCode: noticeRevisions.categoryCode,
    originKind: notices.originKind,
    authorId: communityUsers.userId,
    authorName: profileRevisions.displayName,
    authorProfileState: communityUsers.profileState,
    firstPublishedAt: notices.firstPublishedAt,
    updatedAt: noticeRevisions.createdAt,
  }).from(notices)
    .innerJoin(noticeRevisions, eq(noticeRevisions.id, notices.publicRevisionId))
    .innerJoin(communityUsers, eq(communityUsers.userId, notices.authorId))
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(eq(notices.id, noticeId), publishedNotice()));
  if (!row || !row.firstPublishedAt) throw new ApiError("NOT_FOUND");
  return {
    id: row.id,
    content: noticeContentView({ title: row.title, body: row.body, categoryCode: row.categoryCode }),
    category: { code: row.categoryCode, name: NOTICE_CATEGORY.name },
    originKind: row.originKind,
    author: authorView(row.authorId, row.authorName, row.authorProfileState),
    firstPublishedAt: row.firstPublishedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedNotice(reader: AccessReader, viewer: Viewer, noticeId: string) {
  const [row] = await reader.select({
    id: notices.id,
    authorId: notices.authorId,
    originKind: notices.originKind,
    publicRevisionId: notices.publicRevisionId,
    forcedHiddenAt: notices.forcedHiddenAt,
    deletedAt: notices.deletedAt,
    version: notices.version,
    createdAt: notices.createdAt,
    updatedAt: notices.updatedAt,
    authorName: profileRevisions.displayName,
  }).from(notices)
    .innerJoin(profiles, eq(profiles.userId, notices.authorId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(
      eq(notices.id, noticeId),
      eq(notices.authorId, viewer.userId),
      or(isNull(notices.deletedAt), retainedDeletedNotice()),
    ));
  if (!row) throw new ApiError("NOT_FOUND");
  return row;
}

async function requestsForNotices(reader: AccessReader, noticeIds: string[]) {
  if (!noticeIds.length) return new Map<string, { latest: typeof noticeRequests.$inferSelect | null;
    pending: typeof noticeRequests.$inferSelect | null }>();
  const rows = await reader.select().from(noticeRequests).where(inArray(noticeRequests.noticeId, noticeIds))
    .orderBy(desc(noticeRequests.submittedAt), desc(noticeRequests.id));
  const byNotice = new Map<string, { latest: typeof noticeRequests.$inferSelect | null;
    pending: typeof noticeRequests.$inferSelect | null }>();
  for (const row of rows) {
    const current = byNotice.get(row.noticeId) ?? { latest: null, pending: null };
    current.latest ??= row;
    if (row.status === "pending") current.pending = row;
    byNotice.set(row.noticeId, current);
  }
  return byNotice;
}

function capabilitiesFor(
  viewer: Viewer,
  notice: { authorId: string; originKind: "school" | "alumni"; publicRevisionId: string | null; deletedAt: Date | null },
  latest: typeof noticeRequests.$inferSelect | null,
  pending: typeof noticeRequests.$inferSelect | null,
): CapabilitySet {
  const own = isOwner(viewer, notice.authorId);
  const writable = viewer.profileState === "public";
  return {
    ...noCapabilities,
    canEdit: own && writable && notice.publicRevisionId !== null && notice.deletedAt === null &&
      pending === null && (viewer.baseRole === "staff" || viewer.baseRole === "alumni"),
    canDelete: own && notice.publicRevisionId !== null && notice.deletedAt === null,
    canWithdraw: own && writable && pending !== null,
    canResubmit: own && writable && notice.originKind === "alumni" && notice.deletedAt === null &&
      pending === null && latest?.status === "rejected",
  };
}

async function contentByRevisionIds(reader: AccessReader, ids: string[]) {
  if (!ids.length) return new Map<string, NoticeContent>();
  const rows = await reader.select({
    id: noticeRevisions.id,
    title: noticeRevisions.title,
    body: noticeRevisions.body,
    categoryCode: noticeRevisions.categoryCode,
  }).from(noticeRevisions).where(inArray(noticeRevisions.id, ids));
  return new Map(rows.map((row) => [row.id, noticeContentView(row)]));
}

export async function searchMyNotices(
  reader: AccessReader,
  viewer: Viewer,
  query: ReturnType<typeof parseMyNoticeQuery>,
): Promise<{ data: { items: ManagedNoticeListItem[] }; page: PageInfo }> {
  const { state, sort, limit, cursor } = query;
  const dateColumn = sort === "updated_desc" ? notices.updatedAt : notices.createdAt;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "me/notices",
    filters: { state },
    sort: `${sort},id:desc`,
  }, managedCursorPosition);
  const last = codec.decode(cursor);
  const authorized = and(
    eq(notices.authorId, viewer.userId),
    or(isNull(notices.deletedAt), retainedDeletedNotice()),
  )!;
  const cursorCondition = last
    ? sql`(${dateColumn}, ${notices.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
    : undefined;
  const filtered = stateCondition(reader, state);
  const { data: { items: selected }, page } = await queryListPage({
    authorized,
    filters: filtered,
    after: cursorCondition,
    limit,
    rows: (where, take) => reader.select({
      id: notices.id,
      authorId: notices.authorId,
      originKind: notices.originKind,
      publicRevisionId: notices.publicRevisionId,
      forcedHiddenAt: notices.forcedHiddenAt,
      deletedAt: notices.deletedAt,
      version: notices.version,
      createdAt: notices.createdAt,
      updatedAt: notices.updatedAt,
      cursorAt: cursorTimestamp(dateColumn),
    }).from(notices).where(where).orderBy(desc(dateColumn), desc(notices.id)).limit(take),
    count: async (condition) => {
      const [{ total }] = await reader.select({ total: count() }).from(notices).where(condition);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row) => row,
  });
  const ids = selected.map((row) => row.id);
  const requests = await requestsForNotices(reader, ids);
  const revisionIds = selected.flatMap((row) => {
    if (row.publicRevisionId) return [row.publicRevisionId];
    const latest = requests.get(row.id)?.latest;
    return latest ? [latest.revisionId] : [];
  });
  const contents = await contentByRevisionIds(reader, revisionIds);
  const items = selected.map((row): ManagedNoticeListItem => {
    const requestSet = requests.get(row.id) ?? { latest: null, pending: null };
    const revisionId = row.publicRevisionId ?? requestSet.latest?.revisionId;
    const content = revisionId ? contents.get(revisionId) : undefined;
    if (!content) throw new Error("本人一覧のお知らせ本文を取得できません。");
    const publicationState = row.deletedAt ? "deleted" :
      row.forcedHiddenAt ? "hidden" : row.publicRevisionId ? "public" : "unpublished";
    return {
      id: row.id,
      version: row.version,
      title: content.title,
      categoryCode: content.categoryCode,
      originKind: row.originKind,
      publicationState,
      pendingRequest: requestSet.pending ? requestSummary(requestSet.pending) : null,
      latestRequestStatus: requestSet.latest?.status ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      retentionExpiresAt: retentionExpiresAt(row.deletedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      capabilities: capabilitiesFor(viewer, row, requestSet.latest, requestSet.pending),
    };
  });
  return { data: { items }, page };
}

export async function loadMyNotice(reader: AccessReader, viewer: Viewer, noticeId: string): Promise<ManagedContent> {
  const row = await ownedNotice(reader, viewer, noticeId);
  const requestSet = (await requestsForNotices(reader, [row.id])).get(row.id) ?? { latest: null, pending: null };
  const revisionId = row.deletedAt ? row.publicRevisionId : row.publicRevisionId ?? requestSet.latest?.revisionId;
  const contents = revisionId ? await contentByRevisionIds(reader, [revisionId]) : new Map<string, NoticeContent>();
  const content = revisionId ? contents.get(revisionId) ?? null : null;
  if (!content) throw new ApiError("NOT_FOUND");
  const publicationState = row.deletedAt ? "deleted" :
    row.forcedHiddenAt ? "hidden" : row.publicRevisionId ? "public" : "unpublished";
  const capabilities = capabilitiesFor(viewer, row, requestSet.latest, requestSet.pending);
  if (row.deletedAt) {
    return {
      id: row.id, version: row.version, originKind: row.originKind,
      author: { userId: row.authorId, displayName: row.authorName },
      publicationState, publicContent: null,
      pendingRequest: requestSet.pending ? requestSummary(requestSet.pending) : null,
      deletedContent: content, deletedAt: row.deletedAt.toISOString(),
      retentionExpiresAt: retentionExpiresAt(row.deletedAt), capabilities,
    };
  }
  return {
    id: row.id, version: row.version, originKind: row.originKind,
    author: { userId: row.authorId, displayName: row.authorName },
    publicationState, publicContent: content,
    pendingRequest: requestSet.pending ? requestSummary(requestSet.pending) : null,
    deletedContent: null, deletedAt: null, retentionExpiresAt: null, capabilities,
  };
}

export async function listMyNoticeRequests(
  reader: AccessReader,
  viewer: Viewer,
  noticeId: string,
  query: ReturnType<typeof parseRequestQuery>,
) {
  await ownedNotice(reader, viewer, noticeId);
  const { limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: `me/notices/${noticeId}/requests`,
    filters: {},
    sort: "submittedAt:desc,id:desc",
  }, requestCursorPosition);
  const last = codec.decode(cursor);
  return queryListPage({
    authorized: and(eq(notices.authorId, viewer.userId), eq(notices.id, noticeId),
      or(isNull(notices.deletedAt), retainedDeletedNotice()))!,
    filters: undefined,
    after: last
      ? sql`(${noticeRequests.submittedAt}, ${noticeRequests.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      request: noticeRequests,
      cursorAt: cursorTimestamp(noticeRequests.submittedAt),
    }).from(noticeRequests).innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
      .where(and(eq(noticeRequests.noticeId, noticeId), where))
      .orderBy(desc(noticeRequests.submittedAt), desc(noticeRequests.id)).limit(take),
    count: async (where) => {
        const [{ total }] = await reader.select({ total: count() }).from(noticeRequests)
          .innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
          .where(and(eq(noticeRequests.noticeId, noticeId), where));
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.request.id]),
    toItem: (row) => requestSummary(row.request),
  });
}

export async function loadMyNoticeRequest(
  reader: AccessReader,
  viewer: Viewer,
  requestId: string,
): Promise<ReviewRequest> {
  const [row] = await reader.select({
    request: noticeRequests,
    noticeAuthorId: notices.authorId,
    originKind: notices.originKind,
    deletedAt: notices.deletedAt,
    authorName: profileRevisions.displayName,
    profileState: communityUsers.profileState,
  }).from(noticeRequests)
    .innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
    .innerJoin(communityUsers, eq(communityUsers.userId, notices.authorId))
    .innerJoin(profiles, eq(profiles.userId, notices.authorId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(
      eq(noticeRequests.id, requestId),
      eq(notices.authorId, viewer.userId),
      or(isNull(notices.deletedAt), retainedDeletedNotice()),
    ));
  if (!row) throw new ApiError("NOT_FOUND");
  const [revision] = await reader.select({
    title: noticeRevisions.title, body: noticeRevisions.body, categoryCode: noticeRevisions.categoryCode,
  }).from(noticeRevisions).where(eq(noticeRevisions.id, row.request.revisionId));
  if (!revision) throw new ApiError("NOT_FOUND");
  const requestSet = (await requestsForNotices(reader, [row.request.noticeId])).get(row.request.noticeId) ??
    { latest: null, pending: null };
  return {
    ...requestSummary(row.request),
    content: noticeContentView(revision),
    applicant: { userId: row.noticeAuthorId, displayName: row.authorName },
    decisionReason: row.request.decisionReason,
    withdrawalReason: row.request.withdrawalReason,
    capabilities: {
      ...noCapabilities,
      canWithdraw: row.request.status === "pending" && viewer.profileState === "public",
      canResubmit: row.request.status === "rejected" && row.originKind === "alumni" &&
        row.deletedAt === null && requestSet.pending === null && requestSet.latest?.id === row.request.id &&
        viewer.profileState === "public",
    },
  };
}

export function parseNoticeId(value: unknown): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw new ApiError("BAD_REQUEST");
  return result.data;
}
