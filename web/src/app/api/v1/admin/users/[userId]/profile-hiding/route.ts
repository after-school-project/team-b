import { defineAdminApiRoute } from "@/api/admin-route";
import { commitMutation } from "@/api/mutation";
import { openCaseIdsOfUser } from "@/api/report-measures";
import { parsePathParams, readJson, userId as userIdSchema } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeAdminEntry } from "@/auth/admin";
import { reportCases } from "@/db/moderation-schema";
import { profiles } from "@/db/schema";
import { authorizeProfileHidingReplay, hideProfile, profileHidingSchema } from "@/profile/profile-hiding";

export const runtime = "nodejs";

/**
 * API-US-05：プロフィールの非表示（AD-11）。有効な両管理者が利用でき、対象者による区分は行ロック後に判定する。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAdminApiRoute<{
  params: Promise<{ userId: string }>;
}>("any", {
  async POST(request, context, viewer, input) {
    const { userId } = parsePathParams(await context.params, { userId: userIdSchema });
    const hiding = await readJson(request, profileHidingSchema);
    const actorId = viewer.userId;
    const { db } = await import("@/db/client");
    return commitMutation(db, {
      actorId,
      request: input,
      body: hiding,
      resolveUserIds: async () => [userId],
      authorizeEntry: authorizeAdminEntry(actorId, "any"),
      async targets(tx, replayed) {
        const sourceCaseIds = hiding.sourceCaseId === undefined ? [] : [hiding.sourceCaseId];
        // 再送では更新しないため、閲覧権限を確認する起点の案件だけをロックする。
        const caseIds = replayed ? sourceCaseIds : [...await openCaseIdsOfUser(tx, userId), ...sourceCaseIds];
        return [
          { stage: "resource", table: profiles, idColumn: profiles.userId, ids: replayed ? [] : [userId] },
          { stage: "case", table: reportCases, idColumn: reportCases.id, ids: caseIds },
        ];
      },
      async authorizeReplay(locked, original) {
        await authorizeProfileHidingReplay(locked, { actorId, userId, hiding });
        if (original.resource.type !== "user" || original.resource.id !== userId) throw new ApiError("NOT_FOUND");
      },
      async execute(locked) {
        const { version } = await hideProfile(locked, { actorId, userId, hiding });
        return { status: 200, resource: { type: "user", id: userId }, version, state: "hidden" };
      },
    });
  },
});
