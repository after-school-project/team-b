import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { recordNotification } from "@/api/notifications";
import { expectedVersion, optionalReason, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive, type AccessReader } from "@/auth/access";
import { authorizeAdminEntry, requireAdmin } from "@/auth/admin";
import { retainedDeletedNotice } from "@/auth/visibility";
import { noticeRequests, notices } from "@/db/content-schema";
import type { db } from "@/db/client";
import { managedNoticeAccess, noticeVisibilityScope } from "./admin";

export const noticeDecisionInput = z.strictObject({
  expectedVersion,
  decision: z.enum(["approve", "reject"]),
  reason: optionalReason,
});

export const noticeVisibilityInput = z.strictObject({
  expectedVersion,
  visibility: z.enum(["hidden", "public"]),
  reason: optionalReason,
});

type Database = Pick<typeof db, "transaction">;

async function reviewTarget(reader: AccessReader, requestId: string) {
  const [row] = await reader.select({ request: noticeRequests, notice: notices })
    .from(noticeRequests).innerJoin(notices, eq(notices.id, noticeRequests.noticeId))
    .where(eq(noticeRequests.id, requestId));
  return row;
}

async function requireRetainedNoticeReplay(tx: AccessReader, actorId: string, noticeId: string, replayAt?: Date) {
  if (!replayAt || !requireActive(await loadAccessState(tx, actorId)).roles.schoolManager) {
    throw new ApiError("NOT_FOUND");
  }
  const [retained] = await tx.select({ id: notices.id }).from(notices)
    .where(and(eq(notices.id, noticeId), retainedDeletedNotice(replayAt)));
  if (!retained) throw new ApiError("NOT_FOUND");
}

async function authorizeDecision(tx: AccessReader, actorId: string, requestId: string, replayAt?: Date) {
  const target = await reviewTarget(tx, requestId);
  if (!target || target.request.status === "withdrawn") throw new ApiError("NOT_FOUND");
  if (target.notice.deletedAt) await requireRetainedNoticeReplay(tx, actorId, target.notice.id, replayAt);
  // 学校職員の投稿は即時公開される。申請審査の対象は卒業生による投稿。
  if (target.notice.originKind !== "alumni" || target.notice.authorId === actorId) throw new ApiError("FORBIDDEN");
  return target;
}

export function decideNoticeRequest(
  database: Database, actorId: string, requestId: string,
  input: z.output<typeof noticeDecisionInput>, request: MutationRequest,
) {
  return commitMutation(database, {
    actorId, request, body: input,
    authorizeEntry: authorizeAdminEntry(actorId, "any"),
    async resolveUserIds(tx) {
      const [target] = await tx.select({ authorId: notices.authorId }).from(noticeRequests)
        .innerJoin(notices, eq(notices.id, noticeRequests.noticeId)).where(eq(noticeRequests.id, requestId));
      return target ? [target.authorId] : [];
    },
    async targets(tx) {
      const [target] = await tx.select({ noticeId: noticeRequests.noticeId }).from(noticeRequests)
        .where(eq(noticeRequests.id, requestId));
      return target ? [
        { stage: "resource", table: notices, idColumn: notices.id, ids: [target.noticeId] },
        { stage: "application", table: noticeRequests, idColumn: noticeRequests.id, ids: [requestId] },
      ] : [];
    },
    async authorizeReplay({ tx, now }) {
      await authorizeDecision(tx, actorId, requestId, now);
    },
    async execute(context) {
      const { tx, now } = context;
      const { request: target, notice } = await authorizeDecision(tx, actorId, requestId);
      assertExpectedVersion(target.version, input.expectedVersion);
      if (target.status !== "pending" || (target.requestKind === "new") !== (notice.publicRevisionId === null)) {
        throw new ApiError("STATE_CONFLICT");
      }

      const state = input.decision === "approve" ? "approved" : "rejected";
      const version = target.version + 1;
      const reason = state === "rejected" ? input.reason : null;
      await tx.update(noticeRequests).set({ status: state, reviewerId: actorId, decidedAt: now, decisionReason: reason, version })
        .where(eq(noticeRequests.id, requestId));
      if (state === "approved") {
        await tx.update(notices).set({
          publicRevisionId: target.revisionId,
          firstPublishedAt: notice.firstPublishedAt ?? now,
          version: notice.version + 1,
          updatedAt: now,
        }).where(eq(notices.id, notice.id));
      }
      await recordNotification(context, {
        recipientId: notice.authorId, actorId,
        subject: state === "approved"
          ? { kind: "notice_review_decided", noticeRequestId: requestId, decision: state }
          : { kind: "notice_review_decided", noticeRequestId: requestId, decision: state, publicReason: reason },
        at: now,
      });
      return { status: 200, resource: { type: "notice_request", id: requestId }, version, state };
    },
  });
}

async function authorizeVisibility(tx: AccessReader, actorId: string, noticeId: string, now: Date) {
  const viewer = requireActive(await loadAccessState(tx, actorId));
  const [notice] = await tx.select().from(notices)
    .where(and(eq(notices.id, noticeId), managedNoticeAccess(viewer, now)));
  if (!notice) throw new ApiError("NOT_FOUND");
  requireAdmin(viewer, noticeVisibilityScope(notice.originKind));
  return notice;
}

export function changeNoticeVisibility(
  database: Database, actorId: string, noticeId: string,
  input: z.output<typeof noticeVisibilityInput>, request: MutationRequest,
) {
  return commitMutation(database, {
    actorId, request, body: input,
    authorizeEntry: authorizeAdminEntry(actorId, "any"),
    async targets() {
      return [{ stage: "resource", table: notices, idColumn: notices.id, ids: [noticeId] }];
    },
    async authorizeReplay({ tx, now }) {
      await authorizeVisibility(tx, actorId, noticeId, now);
    },
    async execute({ tx, now }) {
      const notice = await authorizeVisibility(tx, actorId, noticeId, now);
      if (notice.deletedAt) throw new ApiError("STATE_CONFLICT");
      assertExpectedVersion(notice.version, input.expectedVersion);
      const previous = notice.forcedHiddenAt ? "hidden" : "public";
      const state = input.visibility;
      if (previous === state) throw new ApiError("STATE_CONFLICT");
      const version = notice.version + 1;
      await tx.update(notices).set({ forcedHiddenAt: state === "hidden" ? now : null, updatedAt: now, version })
        .where(eq(notices.id, noticeId));
      await recordAuditLog(tx, {
        actorId, targetId: noticeId, at: now,
        action: state === "hidden" ? "notice.hidden" : "notice.restored",
        before: { publicationState: previous, version: notice.version },
        after: { publicationState: state, version },
        publicReason: input.reason,
      });
      return { status: 200, resource: { type: "notice", id: noticeId }, version, state };
    },
  });
}
