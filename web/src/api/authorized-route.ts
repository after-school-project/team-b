import { requireActiveViewer, type Viewer } from "@/auth/access";
import type { MutationRequest } from "./request";
import { defineApiRoute, type HandlerResult } from "./route";

type Result = HandlerResult | Promise<HandlerResult>;
type AuthorizedHandlers<Context> = Partial<{
  GET: (request: Request, context: Context, viewer: Viewer) => Result;
  POST: (request: Request, context: Context, viewer: Viewer, input: MutationRequest) => Result;
  PATCH: (request: Request, context: Context, viewer: Viewer, input: MutationRequest) => Result;
}>;

/**
 * ログイン後の業務API（停止中は利用できないもの）の Route Handler を定義する。
 *
 * 各処理の前に共通認可サービスでセッション・発行／学校確認・停止を判定し、
 * 未認証は 401 AUTH_REQUIRED、未完了は 403 ACCOUNT_NOT_READY、停止中は 403 ACCOUNT_SUSPENDED を返す。
 * 処理にはDBから読んだ最新の Viewer を渡す。actorId・所属・権限はリクエストから受け取らない。
 *
 * 更新では、この判定は早期の拒否として扱う。`commitMutation` には `actorId: viewer.userId` と
 * `authorizeEntry: authorizeActiveEntry(viewer.userId)` を渡し、行ロック後に最新状態で再判定する。
 * 本人向けの状態案内（`GET /api/v1/me`）だけは停止中も 200 を返すため、この関数を使わない。
 */
export function defineAuthorizedApiRoute<Context = unknown>(
  handlers: AuthorizedHandlers<Context>,
  environment?: Parameters<typeof defineApiRoute>[1],
) {
  const { GET, POST, PATCH } = handlers;
  return defineApiRoute<Context>({
    GET: GET && (async (request, context) => GET(request, context, await requireActiveViewer(request.headers))),
    POST: POST && (async (request, context, input) =>
      POST(request, context, await requireActiveViewer(request.headers), input)),
    PATCH: PATCH && (async (request, context, input) =>
      PATCH(request, context, await requireActiveViewer(request.headers), input)),
  }, environment);
}
