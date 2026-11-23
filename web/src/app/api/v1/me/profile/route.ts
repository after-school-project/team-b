import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { commitMutation } from "@/api/mutation";
import { parseQuery, readJson } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeActiveEntry } from "@/auth/access";
import { profileReviews, profiles } from "@/db/schema";
import { loadMyProfile, profilePatchSchema, requireProfileChanges, saveMyProfile } from "@/profile/my-profile";

export const runtime = "nodejs";

/** DBクライアントは要求時に読み込む。ビルド時（ページ情報の収集）にDB接続情報を必要としないため。 */
async function database() {
  return (await import("@/db/client")).db;
}

/**
 * API-PRO-01・02：マイプロフィールの取得と保存（GE-02）。
 * 停止していない本人だけが利用でき、プロフィール非表示中も取得・保存できる（保存は再公開申請になる）。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute({
  async GET(request, _context, viewer) {
    parseQuery(new URL(request.url), {});
    return { data: await loadMyProfile(await database(), viewer.userId) };
  },

  async PATCH(request, _context, viewer, input) {
    const patch = await readJson(request, profilePatchSchema);
    requireProfileChanges(patch);
    const userId = viewer.userId;
    return commitMutation(await database(), {
      actorId: userId,
      request: input,
      body: patch,
      // プロフィール非表示中の保存も許可する（再公開申請になる）ため、プロフィール状態による制限はかけない。
      authorizeEntry: authorizeActiveEntry(userId),
      targets: async () => [
        { stage: "resource", table: profiles, idColumn: profiles.userId, ids: [userId] },
        { stage: "application", table: profileReviews, idColumn: profileReviews.userId, ids: [userId] },
      ],
      async authorizeReplay(_context, original) {
        // 操作記録は実行者ごとのため、本人のプロフィール以外の結果は返さない。
        if (original.resource.type !== "profile" || original.resource.id !== userId) throw new ApiError("NOT_FOUND");
      },
      async execute({ tx, now }) {
        const saved = await saveMyProfile(tx, { userId, patch, now });
        return { status: 200, resource: { type: "profile", id: userId }, version: saved.version, state: saved.state };
      },
    });
  },
});
