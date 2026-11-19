import { requireActiveViewer, type Viewer } from "@/auth/access";
import { defineActorApiRoute, type ActorHandlers } from "./route";

/**
 * ログイン後の業務API（停止中は利用できないもの）の Route Handler を定義する。
 *
 * 各処理の前に共通認可サービスでセッション・発行／学校確認・停止を判定し、
 * 未認証は 401 AUTH_REQUIRED、未完了は 403 ACCOUNT_NOT_READY、停止中は 403 ACCOUNT_SUSPENDED を返す。
 * 更新では Origin の確認だけをこの判定より先に行い、Content-Type・再送キーなどの形式はその後に確認する。
 * 処理にはDBから読んだ最新の Viewer を渡す。actorId・所属・権限はリクエストから受け取らない。
 *
 * 更新では、この判定は早期の拒否として扱う。`commitMutation` には `actorId: viewer.userId` と
 * `authorizeEntry: authorizeActiveEntry(viewer.userId)` を渡し、行ロック後に最新状態で再判定する。
 * 本人向けの状態案内（`GET /api/v1/me`）だけは停止中も 200 を返すため、この関数を使わない。
 */
export function defineAuthorizedApiRoute<Context = unknown>(
  handlers: ActorHandlers<Context, Viewer>,
  environment?: Parameters<typeof defineActorApiRoute>[2],
) {
  return defineActorApiRoute<Context, Viewer>(handlers, (request) => requireActiveViewer(request.headers), environment);
}
