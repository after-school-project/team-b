import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion } from "@/api/mutation";
import { recordNotification } from "@/api/notifications";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { expectedVersion, optionalReason } from "@/api/request";
import type { CaseWriter } from "@/api/report-evidence";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { requireAdminForLockedTarget } from "@/auth/admin";
import { noCapabilities, type CapabilitySet } from "@/auth/capabilities";
import { projectOptionalProfileFields, type OptionalProfileField } from "@/auth/visibility";
import { communityUsers, profileReviews, profileRevisions, profiles } from "@/db/schema";
import type { ProfileReviewSummary } from "./my-profile";
import type { PublicProfileFields } from "./public-profile";

/**
 * プロフィールの再公開審査（API-PR-01〜03、AD-15）。Issue #8 ⑤。
 *
 * - 一般の利用者の申請は有効な両管理者、アプリ管理者の申請は学校管理者だけが取得・審査できる。学校管理者の
 *   プロフィールは審査の対象外（共通認可条件表 §4）。取得できない申請は、一覧・件数に含めず、ID指定では存在しない
 *   申請と同じ404にする。
 * - 審査に返すのは公開予定の基本項目と、本人が公開を許可した（`members`）任意項目だけ。
 * - 申請者は審査中も内容を修正できるため、審査する版（`profile_reviews.version`）が表示時と一致する場合だけ確定する。
 */

/** API設計書 §3 プロフィール再公開審査の一覧条件。 */
export const profileReviewFilters = {
  status: z.enum(["pending", "approved", "rejected", "all"]).default("pending"),
};

export type ProfileReviewQuery = ReturnType<typeof parseProfileReviewQuery>;

/** URLのクエリーを検証する。未定義の項目・形式の誤りは 400 BAD_REQUEST。 */
export function parseProfileReviewQuery(url: URL) {
  return parseListQuery(url, profileReviewFilters);
}

/** 閲覧者が取得・審査できる申請。一覧・件数・詳細に同じ条件を使う。 */
function reviewableBy(viewer: Pick<Viewer, "roles">): SQL {
  return and(
    eq(communityUsers.schoolManager, false),
    viewer.roles.schoolManager ? undefined : eq(communityUsers.appManager, false),
  )!;
}

const summaryColumns = {
  id: profileReviews.id,
  status: profileReviews.status,
  submittedAt: profileReviews.submittedAt,
  decidedAt: profileReviews.decidedAt,
  decisionReason: profileReviews.decisionReason,
  version: profileReviews.version,
};

type SummaryRow = {
  id: string; status: ProfileReviewSummary["status"]; submittedAt: Date; decidedAt: Date | null;
  decisionReason: string | null; version: number;
};

function toSummary(row: SummaryRow): ProfileReviewSummary {
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    version: row.version,
  };
}

/** 画面の一覧に表示する申請。API では `review`（ProfileReviewSummary）だけを返す。 */
export type ProfileReviewListItem = { review: ProfileReviewSummary; displayName: string };

const cursorPosition = z.tuple([z.string(), z.string()]);

/**
 * 再公開申請の一覧（API-PR-01）。審査待ちは申請日時の古い順、それ以外は新しい順。
 * カーソルは閲覧者・条件・並び順にひも付けて署名する。
 */
export async function listProfileReviews(reader: AccessReader, viewer: Viewer, query: ProfileReviewQuery) {
  const { status, limit, cursor } = query;
  const ascending = status === "pending";
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "profile-reviews",
    filters: { status },
    sort: ascending ? "submittedAt:asc,id:asc" : "submittedAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const position = sql`(${profileReviews.submittedAt}, ${profileReviews.id})`;
  const lastPosition = last ? sql`(${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined;
  const order = ascending ? asc : desc;

  return queryListPage({
    authorized: reviewableBy(viewer),
    filters: status === "all" ? undefined : eq(profileReviews.status, status),
    after: lastPosition && (ascending ? sql`${position} > ${lastPosition}` : sql`${position} < ${lastPosition}`),
    limit,
    rows: (where, take) => reader.select({
      ...summaryColumns,
      displayName: profileRevisions.displayName,
      cursorAt: cursorTimestamp(profileReviews.submittedAt),
    }).from(profileReviews)
      .innerJoin(communityUsers, eq(communityUsers.userId, profileReviews.userId))
      .innerJoin(profileRevisions, eq(profileRevisions.id, profileReviews.revisionId))
      .where(where).orderBy(order(profileReviews.submittedAt), order(profileReviews.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(profileReviews)
        .innerJoin(communityUsers, eq(communityUsers.userId, profileReviews.userId))
        .innerJoin(profileRevisions, eq(profileRevisions.id, profileReviews.revisionId))
        .where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): ProfileReviewListItem => ({ review: toSummary(row), displayName: row.displayName }),
  });
}

/** API設計書 §5 ProfileReview。 */
export type ProfileReview = ProfileReviewSummary & {
  userId: string;
  profileRevisionId: string;
  profileFields: PublicProfileFields;
  capabilities: CapabilitySet;
};

/** 再公開申請の詳細（API-PR-02）。取得できない申請は、存在しない申請と同じ404。 */
export async function loadProfileReview(reader: AccessReader, viewer: Viewer, reviewId: string): Promise<ProfileReview> {
  const [row] = await reader.select({
    ...summaryColumns,
    userId: profileReviews.userId,
    profileRevisionId: profileReviews.revisionId,
    displayName: profileRevisions.displayName,
    department: profileRevisions.department,
    entryYear: profileRevisions.entryYear,
    graduationYear: profileRevisions.graduationYear,
    optionalValues: profileRevisions.optionalValues,
    fieldVisibility: profileRevisions.fieldVisibility,
  }).from(profileReviews)
    .innerJoin(communityUsers, eq(communityUsers.userId, profileReviews.userId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profileReviews.revisionId))
    .where(and(eq(profileReviews.id, reviewId), reviewableBy(viewer)));
  if (!row) throw new ApiError("NOT_FOUND");

  const optionalFields = projectOptionalProfileFields(row, "member");
  if (row.status !== "pending") {
    // 審査の確定後に本人が「自分だけ」に変えた項目は、過去の申請からも返さない。
    const [current] = await reader.select({
      optionalValues: profileRevisions.optionalValues, fieldVisibility: profileRevisions.fieldVisibility,
    }).from(profiles)
      .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
      .where(eq(profiles.userId, row.userId));
    const shared = current ? projectOptionalProfileFields(current, "member") : {};
    for (const field of Object.keys(optionalFields) as OptionalProfileField[]) {
      if (!shared[field]) delete optionalFields[field];
    }
  }

  return {
    ...toSummary(row),
    userId: row.userId,
    profileRevisionId: row.profileRevisionId,
    profileFields: {
      displayName: row.displayName,
      department: row.department,
      entryYear: row.entryYear,
      graduationYear: row.graduationYear,
      optionalFields,
    },
    capabilities: { ...noCapabilities, canReview: row.status === "pending" },
  };
}

/** API設計書 §11 ReviewDecision。 */
export const reviewDecisionSchema = z.strictObject({
  expectedVersion,
  decision: z.enum(["approve", "reject"]),
  reason: optionalReason,
});

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/** 却下には空白以外の理由が必要（422）。 */
export function requireRejectionReason(decision: ReviewDecision): void {
  if (decision.decision === "reject" && decision.reason === null) {
    throw new ApiError("VALIDATION_FAILED", {
      fields: [{ path: "reason", code: "missing_reason", message: "却下の理由を入力してください。" }],
    });
  }
}

/** 申請者のID。`commitMutation` の `resolveUserIds` と `targets` に使う。確定には使わない。 */
export async function profileReviewApplicant(reader: AccessReader, reviewId: string): Promise<string | null> {
  const [row] = await reader.select({ userId: profileReviews.userId }).from(profileReviews)
    .where(eq(profileReviews.id, reviewId));
  return row?.userId ?? null;
}

type LockedContext = { tx: CaseWriter; now: Date; requireLockedUsers: (...ids: string[]) => void };

/**
 * 申請の審査の権限を、ロック後の最新状態で確認し、申請を返す。`execute` と `authorizeReplay` で呼ぶ。
 * 実行者自身の資格は入口（`authorizeAdminEntry`）でロック後に確認済みのため、ここでの資格不足は対象者による制限だけ。
 * 取得できない申請の存在を明かさないよう、存在しない申請と同じ404にする。
 */
export async function authorizeProfileReview(context: LockedContext, actorId: string, reviewId: string) {
  const [review] = await context.tx.select().from(profileReviews).where(eq(profileReviews.id, reviewId));
  if (!review) throw new ApiError("NOT_FOUND");
  try {
    const { target: { schoolManager } } = await requireAdminForLockedTarget(context, actorId, review.userId);
    if (schoolManager) throw new ApiError("NOT_FOUND");
  } catch (error) {
    if (error instanceof ApiError && error.code === "FORBIDDEN") throw new ApiError("NOT_FOUND");
    throw error;
  }
  return review;
}

/**
 * 再公開申請を承認・却下する（API-PR-03）。`commitMutation` の `execute` の中で呼び、`resolveUserIds` に申請者、
 * `targets` に申請者の `profiles`（本体）と申請をロックしておく。
 * 承認でプロフィールを公開し、却下では非表示を維持する。停止など、ほかの制限は変えない。
 */
export async function decideProfileReview(
  context: LockedContext, input: { actorId: string; reviewId: string; decision: ReviewDecision },
): Promise<{ version: number; state: "approved" | "rejected" }> {
  const { tx, now } = context;
  const { actorId, reviewId, decision } = input;
  const review = await authorizeProfileReview(context, actorId, reviewId);
  if (review.status !== "pending") throw new ApiError("STATE_CONFLICT");
  assertExpectedVersion(review.version, decision.expectedVersion);

  const [applicant] = await tx.select({
    profileState: communityUsers.profileState,
    version: communityUsers.version,
    currentRevisionId: profiles.currentRevisionId,
    profileVersion: profiles.version,
  }).from(communityUsers).innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .where(eq(communityUsers.userId, review.userId));
  // 審査中の申請は、非表示中の本人の現在版を指す（保存と申請の更新は同じトランザクション）。
  // 一致しない状態で承認すると、審査していない版が公開されるため確定しない。
  if (!applicant || applicant.profileState !== "hidden" || applicant.currentRevisionId !== review.revisionId) {
    throw new ApiError("STATE_CONFLICT");
  }

  const state = decision.decision === "approve" ? "approved" : "rejected";
  const version = review.version + 1;
  await tx.update(profileReviews).set({
    status: state, version, reviewerId: actorId, decidedAt: now, decisionReason: decision.reason,
  }).where(eq(profileReviews.id, reviewId));

  const profileState = state === "approved" ? "public" : "hidden";
  if (state === "approved") {
    await tx.update(communityUsers).set({ profileState, version: applicant.version + 1 })
      .where(eq(communityUsers.userId, review.userId));
    // 非表示中の画面からの保存は再公開申請のつもりの内容なので、審査なしで公開しないよう409にする。
    await tx.update(profiles).set({ version: applicant.profileVersion + 1 }).where(eq(profiles.userId, review.userId));
  }

  await recordAuditLog(tx, {
    action: state === "approved" ? "profile_review.approved" : "profile_review.rejected",
    actorId, targetId: reviewId,
    before: { status: "pending", profileState: "hidden", version: review.version },
    after: { status: state, profileState, version },
    publicReason: decision.reason, at: now,
  });
  await recordNotification(context, {
    recipientId: review.userId, actorId, at: now,
    subject: decision.decision === "approve"
      ? { kind: "profile_review_decided", profileReviewId: reviewId, decision: "approved" }
      : { kind: "profile_review_decided", profileReviewId: reviewId, decision: "rejected", publicReason: decision.reason ?? "" },
  });
  return { version, state };
}
