import { and, desc, eq, sql } from "drizzle-orm";
import { ApiError } from "@/api/response";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { recordReviewRequestNotifications, reviewRequestRecipients } from "@/api/notifications";
import type { MutationRequest } from "@/api/request";
import { authorizeActiveEntry, loadAccessState, requireProfileWritable, requireActive } from "@/auth/access";
import type { Viewer } from "@/auth/access";
import { noticeRequests, noticeRevisions, notices } from "@/db/content-schema";
import type { db } from "@/db/client";
import type { createNoticeInput, deletionInput, editNoticeInput, resubmissionInput, withdrawalInput } from "./notices";

type Database = Pick<typeof db, "transaction">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Content = typeof createNoticeInput._output;
type CreateInput = Content;
type EditInput = typeof editNoticeInput._output;
type WithdrawalInput = typeof withdrawalInput._output;
type ResubmissionInput = typeof resubmissionInput._output;
type DeletionInput = typeof deletionInput._output;

async function activeActor(tx: Transaction, actorId: string): Promise<Viewer> {
  return requireActive(await loadAccessState(tx, actorId));
}

function assertCanSubmit(viewer: Viewer) {
  if (viewer.baseRole === "student") throw new ApiError("FORBIDDEN");
}

async function nextRevisionNo(tx: Transaction, noticeId: string): Promise<number> {
  const [last] = await tx.select({ revisionNo: noticeRevisions.revisionNo }).from(noticeRevisions)
    .where(eq(noticeRevisions.noticeId, noticeId))
    .orderBy(desc(noticeRevisions.revisionNo)).limit(1);
  return (last?.revisionNo ?? 0) + 1;
}

async function notifyReviewers(
  tx: Transaction,
  requireLockedUsers: (...ids: string[]) => void,
  applicantId: string,
  requestId: string,
  now: Date,
) {
  await recordReviewRequestNotifications({ tx, requireLockedUsers }, {
    applicantId,
    subject: { kind: "notice_review_requested", noticeRequestId: requestId },
    at: now,
  });
}

/** 申請の再送では保存結果が申請なので、申請経由で所有者を確認する。 */
async function ensureOwnedResource(tx: Transaction, actorId: string, resource: { type: string; id: string }) {
  if (resource.type === "notice_request") await ensureOwnedRequest(tx, actorId, resource.id);
  else await ensureOwnedNotice(tx, actorId, resource.id);
}

async function nextPendingNoticeIds(tx: Transaction, noticeId: string) {
  const requests = await tx.select({ id: noticeRequests.id }).from(noticeRequests).where(and(
    eq(noticeRequests.noticeId, noticeId),
    eq(noticeRequests.status, "pending"),
  ));
  return requests.map(({ id }) => id);
}

async function ensureOwnedNotice(tx: Transaction, actorId: string, noticeId: string) {
  const [notice] = await tx.select().from(notices).where(eq(notices.id, noticeId));
  if (!notice || notice.authorId !== actorId) throw new ApiError("NOT_FOUND");
  return notice;
}

async function ensureOwnedRequest(tx: Transaction, actorId: string, requestId: string) {
  const [request] = await tx.select().from(noticeRequests).where(eq(noticeRequests.id, requestId));
  if (!request) throw new ApiError("NOT_FOUND");
  const notice = await ensureOwnedNotice(tx, actorId, request.noticeId);
  return { request, notice };
}

async function ensureLatestRequest(tx: Transaction, requestId: string, noticeId: string) {
  const [latest] = await tx.select({ id: noticeRequests.id }).from(noticeRequests)
    .where(eq(noticeRequests.noticeId, noticeId))
    .orderBy(desc(noticeRequests.submittedAt), desc(noticeRequests.id)).limit(1);
  if (latest?.id !== requestId) throw new ApiError("STATE_CONFLICT");
}

export async function createNotice(
  database: Database,
  viewer: Viewer,
  content: CreateInput,
  request: MutationRequest,
) {
  assertCanSubmit(viewer);
  return commitMutation(database, {
    actorId: viewer.userId,
    request,
    body: content,
    resolveUserIds: async (tx) => {
      const currentViewer = await activeActor(tx, viewer.userId);
      return currentViewer.baseRole === "alumni"
        ? reviewRequestRecipients(tx, viewer.userId)
        : [];
    },
    authorizeEntry: authorizeActiveEntry(viewer.userId, { profileWritable: true }),
    async targets() {
      return [];
    },
    async authorizeReplay({ tx }, original) {
      await ensureOwnedResource(tx, viewer.userId, original.resource);
    },
    async execute({ tx, now, requireLockedUsers }) {
      const currentViewer = await activeActor(tx, viewer.userId);
      requireProfileWritable(currentViewer);
      assertCanSubmit(currentViewer);
      const currentOrigin = currentViewer.baseRole === "staff" ? "school" : "alumni";
      const [notice] = await tx.insert(notices).values({
        authorId: viewer.userId,
        originKind: currentOrigin,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: notices.id });
      const [revision] = await tx.insert(noticeRevisions).values({
        noticeId: notice.id,
        revisionNo: 1,
        title: content.title,
        body: content.body,
        categoryCode: content.categoryCode,
        createdAt: now,
      }).returning({ id: noticeRevisions.id });

      if (currentViewer.baseRole === "staff") {
        await tx.update(notices).set({
          publicRevisionId: revision.id,
          firstPublishedAt: now,
        }).where(eq(notices.id, notice.id));
        return {
          status: 201,
          resource: { type: "notice", id: notice.id },
          version: 1,
          state: "public",
        };
      }

      const [reviewRequest] = await tx.insert(noticeRequests).values({
        noticeId: notice.id,
        revisionId: revision.id,
        requestKind: "new",
        status: "pending",
        submittedAt: now,
        version: 1,
      }).returning({ id: noticeRequests.id });
      await notifyReviewers(tx, requireLockedUsers, viewer.userId, reviewRequest.id, now);
      return {
        status: 201,
        resource: { type: "notice_request", id: reviewRequest.id },
        version: 1,
        state: "pending",
      };
    },
  });
}

export async function reviseNotice(
  database: Database,
  viewer: Viewer,
  noticeId: string,
  input: EditInput,
  request: MutationRequest,
) {
  assertCanSubmit(viewer);
  return commitMutation(database, {
    actorId: viewer.userId,
    request,
    body: input,
    resolveUserIds: async (tx) => {
      const currentViewer = await activeActor(tx, viewer.userId);
      return currentViewer.baseRole === "alumni" ? reviewRequestRecipients(tx, viewer.userId) : [];
    },
    authorizeEntry: authorizeActiveEntry(viewer.userId, { profileWritable: true }),
    async targets() {
      // 再送の照合はパスを含むため、再送時も対象はパスのお知らせと同じ。
      return [{
        stage: "resource",
        table: notices,
        idColumn: notices.id,
        ids: [noticeId],
      }];
    },
    async authorizeReplay({ tx }, original) {
      await ensureOwnedResource(tx, viewer.userId, original.resource);
    },
    async execute({ tx, now, requireLockedUsers }) {
      const currentViewer = await activeActor(tx, viewer.userId);
      requireProfileWritable(currentViewer);
      assertCanSubmit(currentViewer);
      const notice = await ensureOwnedNotice(tx, viewer.userId, noticeId);
      if (notice.publicRevisionId === null || notice.deletedAt !== null) throw new ApiError("NOT_FOUND");
      assertExpectedVersion(notice.version, input.expectedVersion);
      const [pending] = await tx.select({ id: noticeRequests.id }).from(noticeRequests).where(and(
        eq(noticeRequests.noticeId, noticeId),
        eq(noticeRequests.status, "pending"),
      )).limit(1);
      if (pending) throw new ApiError("STATE_CONFLICT");
      const revisionNo = await nextRevisionNo(tx, noticeId);
      const [revision] = await tx.insert(noticeRevisions).values({
        noticeId,
        revisionNo,
        title: input.content.title,
        body: input.content.body,
        categoryCode: input.content.categoryCode,
        createdAt: now,
      }).returning({ id: noticeRevisions.id });
      const nextVersion = notice.version + 1;

      if (currentViewer.baseRole === "staff") {
        await tx.update(notices).set({
          publicRevisionId: revision.id,
          version: nextVersion,
          updatedAt: now,
        }).where(eq(notices.id, noticeId));
        return {
          status: 200,
          resource: { type: "notice", id: noticeId },
          version: nextVersion,
          state: notice.forcedHiddenAt ? "hidden" : "public",
        };
      }

      const [reviewRequest] = await tx.insert(noticeRequests).values({
        noticeId,
        revisionId: revision.id,
        requestKind: "edit",
        status: "pending",
        submittedAt: now,
        version: 1,
      }).returning({ id: noticeRequests.id });
      await tx.update(notices).set({ version: nextVersion, updatedAt: now }).where(eq(notices.id, noticeId));
      await notifyReviewers(tx, requireLockedUsers, viewer.userId, reviewRequest.id, now);
      return {
        status: 200,
        resource: { type: "notice_request", id: reviewRequest.id },
        version: 1,
        state: "pending",
      };
    },
  });
}

export async function withdrawNoticeRequest(
  database: Database,
  viewer: Viewer,
  requestId: string,
  input: WithdrawalInput,
  request: MutationRequest,
) {
  return commitMutation(database, {
    actorId: viewer.userId,
    request,
    body: input,
    authorizeEntry: authorizeActiveEntry(viewer.userId, { profileWritable: true }),
    async targets(tx, replayResource) {
      const id = replayResource?.id ?? requestId;
      const [noticeRequest] = await tx.select({ noticeId: noticeRequests.noticeId }).from(noticeRequests)
        .where(eq(noticeRequests.id, id));
      return noticeRequest ? [
        { stage: "resource", table: notices, idColumn: notices.id, ids: [noticeRequest.noticeId] },
        { stage: "application", table: noticeRequests, idColumn: noticeRequests.id, ids: [id] },
      ] : [];
    },
    async authorizeReplay({ tx }, original) {
      await ensureOwnedRequest(tx, viewer.userId, original.resource.id);
    },
    async execute({ tx, now }) {
      const currentViewer = await activeActor(tx, viewer.userId);
      requireProfileWritable(currentViewer);
      const { request: target, notice } = await ensureOwnedRequest(tx, viewer.userId, requestId);
      assertExpectedVersion(target.version, input.expectedVersion);
      if (target.status !== "pending") throw new ApiError("STATE_CONFLICT");
      const version = target.version + 1;
      await tx.update(noticeRequests).set({ status: "withdrawn", version })
        .where(eq(noticeRequests.id, requestId));
      await tx.update(notices).set({ version: notice.version + 1, updatedAt: now })
        .where(eq(notices.id, notice.id));
      return {
        status: 200,
        resource: { type: "notice_request", id: requestId },
        version,
        state: "withdrawn",
      };
    },
  });
}

export async function resubmitNoticeRequest(
  database: Database,
  viewer: Viewer,
  requestId: string,
  input: ResubmissionInput,
  request: MutationRequest,
) {
  return commitMutation(database, {
    actorId: viewer.userId,
    request,
    body: input,
    resolveUserIds: async (tx) => {
      const currentViewer = await activeActor(tx, viewer.userId);
      return currentViewer.baseRole === "alumni" ? reviewRequestRecipients(tx, viewer.userId) : [];
    },
    authorizeEntry: authorizeActiveEntry(viewer.userId, { profileWritable: true }),
    async targets(tx, replayResource) {
      const id = replayResource?.id ?? requestId;
      const [noticeRequest] = await tx.select({ noticeId: noticeRequests.noticeId }).from(noticeRequests)
        .where(eq(noticeRequests.id, id));
      return noticeRequest ? [
        { stage: "resource", table: notices, idColumn: notices.id, ids: [noticeRequest.noticeId] },
        { stage: "application", table: noticeRequests, idColumn: noticeRequests.id, ids: [id] },
      ] : [];
    },
    async authorizeReplay({ tx }, original) {
      await ensureOwnedRequest(tx, viewer.userId, original.resource.id);
    },
    async execute({ tx, now, requireLockedUsers }) {
      const currentViewer = await activeActor(tx, viewer.userId);
      requireProfileWritable(currentViewer);
      if (currentViewer.baseRole !== "alumni") throw new ApiError("FORBIDDEN");
      const { request: rejected, notice } = await ensureOwnedRequest(tx, viewer.userId, requestId);
      assertExpectedVersion(rejected.version, input.expectedVersion);
      if (notice.deletedAt !== null || notice.originKind !== "alumni" || rejected.status !== "rejected") {
        throw new ApiError("STATE_CONFLICT");
      }
      await ensureLatestRequest(tx, requestId, notice.id);
      const [pending] = await tx.select({ id: noticeRequests.id }).from(noticeRequests).where(and(
        eq(noticeRequests.noticeId, notice.id),
        eq(noticeRequests.status, "pending"),
      )).limit(1);
      if (pending) throw new ApiError("STATE_CONFLICT");
      const revisionNo = await nextRevisionNo(tx, notice.id);
      const [revision] = await tx.insert(noticeRevisions).values({
        noticeId: notice.id,
        revisionNo,
        title: input.content.title,
        body: input.content.body,
        categoryCode: input.content.categoryCode,
        createdAt: now,
      }).returning({ id: noticeRevisions.id });
      const [newRequest] = await tx.insert(noticeRequests).values({
        noticeId: notice.id,
        revisionId: revision.id,
        requestKind: rejected.requestKind,
        status: "pending",
        submittedAt: now,
        version: 1,
      }).returning({ id: noticeRequests.id });
      await tx.update(notices).set({ version: notice.version + 1, updatedAt: now })
        .where(eq(notices.id, notice.id));
      await notifyReviewers(tx, requireLockedUsers, viewer.userId, newRequest.id, now);
      return {
        status: 201,
        resource: { type: "notice_request", id: newRequest.id },
        version: 1,
        state: "pending",
      };
    },
  });
}

export async function deleteNotice(
  database: Database,
  viewer: Viewer,
  noticeId: string,
  input: DeletionInput,
  request: MutationRequest,
) {
  return commitMutation(database, {
    actorId: viewer.userId,
    request,
    body: input,
    authorizeEntry: authorizeActiveEntry(viewer.userId),
    async targets(tx, replayResource) {
      const id = replayResource?.id ?? noticeId;
      const requestIds = await nextPendingNoticeIds(tx, id);
      return [
        { stage: "resource", table: notices, idColumn: notices.id, ids: [id] },
        { stage: "application", table: noticeRequests, idColumn: noticeRequests.id, ids: requestIds },
      ];
    },
    async authorizeReplay({ tx }, original) {
      await ensureOwnedNotice(tx, viewer.userId, original.resource.id);
    },
    async execute({ tx, now }) {
      const notice = await ensureOwnedNotice(tx, viewer.userId, noticeId);
      if (notice.publicRevisionId === null || notice.deletedAt !== null) throw new ApiError("NOT_FOUND");
      assertExpectedVersion(notice.version, input.expectedVersion);
      const nextVersion = notice.version + 1;
      await tx.update(notices).set({
        deletedAt: now,
        version: nextVersion,
        updatedAt: now,
      }).where(eq(notices.id, noticeId));
      await tx.update(noticeRequests).set({
        status: "withdrawn",
        version: sql`${noticeRequests.version} + 1`,
      }).where(and(
        eq(noticeRequests.noticeId, noticeId),
        eq(noticeRequests.status, "pending"),
        eq(noticeRequests.requestKind, "edit"),
      ));
      return {
        status: 200,
        resource: { type: "notice", id: noticeId },
        version: nextVersion,
        state: "deleted",
      };
    },
  });
}
