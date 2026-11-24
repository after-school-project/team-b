import { defineAdminApiRoute } from "@/api/admin-route";
import { commitMutation } from "@/api/mutation";
import { openCaseIdsOfUser } from "@/api/report-measures";
import { parsePathParams, readJson, userId as userIdSchema } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeAdminEntry } from "@/auth/admin";
import { reportCases } from "@/db/moderation-schema";
import { profiles } from "@/db/schema";
import { authorizeProfileHiding, hideProfile, profileHidingSchema } from "@/profile/profile-hiding";

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
      targets: async (tx, replayed) => replayed ? [] : [
        { stage: "resource", table: profiles, idColumn: profiles.userId, ids: [userId] },
        {
          stage: "case", table: reportCases, idColumn: reportCases.id,
          ids: [...await openCaseIdsOfUser(tx, userId), ...hiding.sourceCaseId ? [hiding.sourceCaseId] : []],
        },
      ],
      async authorizeReplay(locked, original) {
        await authorizeProfileHiding(locked, actorId, userId);
        if (original.resource.type !== "user" || original.resource.id !== userId) throw new ApiError("NOT_FOUND");
      },
      async execute(locked) {
        const { version } = await hideProfile(locked, { actorId, userId, hiding });
        return { status: 200, resource: { type: "user", id: userId }, version, state: "hidden" };
      },
    });
  },
});
