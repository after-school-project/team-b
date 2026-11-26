import { z } from "zod";
import { defineAuthorizedApiRoute } from "@/api/authorized-route";
import { commitMutation } from "@/api/mutation";
import { parsePathParams, readJson, uuid } from "@/api/request";
import { authorizeActiveEntry } from "@/auth/access";
import { authorizeNotificationReadReplay, markNotificationRead } from "@/notifications/notifications";

export const runtime = "nodejs";

/**
 * API-NT-03：通知を既読にする（GE-06）。停止していない受信者本人が利用できる。プロフィール非表示中も既読にできる。
 * 本文は `{}`。版番号は要求せず、未読の場合だけ既読時刻を設定する。他人の通知と存在しない通知は 404。
 * DBクライアントは要求時に読み込み、ビルド時にDB接続情報を必要としない。
 */
export const { GET, HEAD, OPTIONS, POST, PUT, DELETE, PATCH } = defineAuthorizedApiRoute<{
  params: Promise<{ notificationId: string }>;
}>({
  async POST(request, context, viewer, input) {
    const { notificationId } = parsePathParams(await context.params, { notificationId: uuid });
    const body = await readJson(request, z.object({}));
    const actorId = viewer.userId;
    const { db } = await import("@/db/client");
    return commitMutation(db, {
      actorId,
      request: input,
      body,
      // 行ロック後に、停止されていないことを確認する。プロフィール非表示中も既読にできる（API設計書 §17）。
      authorizeEntry: authorizeActiveEntry(actorId),
      async authorizeReplay({ tx }, original) {
        await authorizeNotificationReadReplay(tx, { actorId, notificationId, original });
      },
      async execute({ tx, now }) {
        return { status: 200, ...await markNotificationRead(tx, { actorId, notificationId, now }) };
      },
    });
  },
});
