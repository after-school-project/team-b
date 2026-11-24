import { defineAdminApiRoute } from "@/api/admin-route";
import { commitMutation } from "@/api/mutation";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeAdminEntry } from "@/auth/admin";
import { profileReviews, profiles } from "@/db/schema";
import {
  authorizeProfileReview, decideProfileReview, profileReviewApplicant, requireRejectionReason, reviewDecisionSchema,
} from "@/profile/profile-reviews";

export const runtime = "nodejs";

/**
 * API-PR-03：プロフィール再公開審査の承認・却下（AD-15）。有効な両管理者が利用でき、申請者による区分は行ロック後に判定する。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ reviewId: string }>;
}>("any", {
  async POST(request, context, viewer, input) {
    const { reviewId } = parsePathParams(await context.params, { reviewId: uuid });
    const decision = await readJson(request, reviewDecisionSchema);
    requireRejectionReason(decision);
    const actorId = viewer.userId;
    const { db } = await import("@/db/client");
    return commitMutation(db, {
      actorId,
      request: input,
      body: decision,
      async resolveUserIds(tx) {
        const applicant = await profileReviewApplicant(tx, reviewId);
        return applicant === null ? [] : [applicant];
      },
      authorizeEntry: authorizeAdminEntry(actorId, "any"),
      async targets(tx) {
        const applicant = await profileReviewApplicant(tx, reviewId);
        return [
          { stage: "resource", table: profiles, idColumn: profiles.userId, ids: applicant === null ? [] : [applicant] },
          { stage: "application", table: profileReviews, idColumn: profileReviews.id, ids: [reviewId] },
        ];
      },
      async authorizeReplay(locked, original) {
        await authorizeProfileReview(locked, actorId, reviewId);
        if (original.resource.type !== "profile_review" || original.resource.id !== reviewId) throw new ApiError("NOT_FOUND");
      },
      async execute(locked) {
        const { version, state } = await decideProfileReview(locked, { actorId, reviewId, decision });
        return { status: 200, resource: { type: "profile_review", id: reviewId }, version, state };
      },
    });
  },
});
