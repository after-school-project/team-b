import { requireAdminViewer, type AdminScope } from "@/auth/admin";
import type { Viewer } from "@/auth/access";
import { defineActorApiRoute, type ActorHandlers } from "./route";

/**
 * 管理エリアの業務API（`/api/v1/admin/*`）の Route Handler を定義する。
 *
 * `defineAuthorizedApiRoute` と同じ順で共通認可（未認証 401、未完了・停止中 403）を行った後、
 * 管理権限を `scope` で確認し、足りなければ処理を呼ばずに 403 FORBIDDEN を返す。
 * 対象者によって学校専用になる操作は、ここでは両管理者（`any`）として入口を通し、対象を読んでから
 * `scopeForTarget` で判定する。更新は `commitMutation` に `authorizeAdminEntry` を渡し、行ロック後に再判定する。
 */
export function defineAdminApiRoute<Context = unknown>(
  scope: AdminScope,
  handlers: ActorHandlers<Context, Viewer>,
  environment?: Parameters<typeof defineActorApiRoute>[2],
) {
  return defineActorApiRoute<Context, Viewer>(
    handlers,
    (request) => requireAdminViewer(request.headers, scope),
    environment,
  );
}
