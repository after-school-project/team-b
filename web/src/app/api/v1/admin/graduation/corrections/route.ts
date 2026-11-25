import { correctGraduation, graduationCorrectionSchema, requireCorrectableState } from "@/admin/graduation";
import { defineAdminApiRoute } from "@/api/admin-route";
import { commitMutation } from "@/api/mutation";
import { readJson } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeAdminEntry } from "@/auth/admin";

export const runtime = "nodejs";

/**
 * API-GR-03：卒業区分の指定修正（AD-13）。学校管理者だけが利用できる。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute("school", {
  async POST(request, _context, viewer, input) {
    const correction = await readJson(request, graduationCorrectionSchema);
    requireCorrectableState(correction);
    const actorId = viewer.userId;
    const { db } = await import("@/db/client");
    return commitMutation(db, {
      actorId,
      request: input,
      body: correction,
      resolveUserIds: async () => [correction.userId],
      authorizeEntry: authorizeAdminEntry(actorId, "school"),
      // 学校管理者はすべての変更履歴を閲覧できる。実行者の資格は入口で、ロック後の状態で確認済み。
      async authorizeReplay(_context, original) {
        if (original.resource.type !== "graduation_batch") throw new ApiError("NOT_FOUND");
      },
      async execute(locked) {
        const { batchId } = await correctGraduation(locked, { actorId, correction });
        return {
          status: 201, resource: { type: "graduation_batch", id: batchId }, version: null, state: "corrected", affectedCount: 1,
        };
      },
    });
  },
});
