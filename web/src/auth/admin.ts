import "server-only";
import { eq } from "drizzle-orm";
import { ApiError } from "@/api/response";
import { communityUsers } from "@/db/schema";
import {
  canEnterAdmin,
  loadAccessState,
  requireActive,
  requireActiveViewer,
  type AccessReader,
  type Viewer,
} from "./access";

/**
 * 管理権限の共通判定（Issue #7 ⑤）。共通認可条件表 §1・§4 に従う。
 *
 * - 判定には毎回DBから読んだ最新の Viewer を使う。停止・プロフィール非表示・権限解除は次の管理要求から反映する。
 * - 管理権限が足りない場合は 403 FORBIDDEN。一般利用者としての利用（ログイン・基本所属）は変えない。
 * - 自己審査の禁止、学校管理者を対象にできない操作、案件の学校専用属性など、操作ごとの条件は各機能で判定する。
 */

/**
 * 管理操作に必要な権限の区分。
 * - `school`：学校管理者のみ（本人確認情報、削除済み証拠、操作ログ、卒業区分、アプリ管理者の付与・解除、引継ぎ待ちなど）
 * - `any`：有効な両管理者（学校管理者、または停止・プロフィール非表示・権限解除の制限がないアプリ管理者）
 */
export type AdminScope = "school" | "any";

/** 対象者の現在の管理権限。対象者によって学校専用になる操作の判定に使う。 */
export type TargetRoles = { schoolManager: boolean; appManager: boolean };

/** 利用中の閲覧者が、指定した区分の管理操作を行えるか。 */
export function hasAdminScope(viewer: Viewer, scope: AdminScope): boolean {
  return scope === "school" ? viewer.roles.schoolManager : canEnterAdmin(viewer);
}

/** 管理操作の資格を確認し、足りなければ 403 FORBIDDEN を投げる。 */
export function requireAdmin(viewer: Viewer, scope: AdminScope): void {
  if (!hasAdminScope(viewer, scope)) throw new ApiError("FORBIDDEN");
}

/**
 * 対象者によって学校専用になる操作に必要な区分。対象者がアプリ管理者なら学校管理者のみ、それ以外は有効な両管理者。
 * 例：アプリ管理者の停止・プロフィール非表示、アプリ管理者が投稿したQ&Aの強制非表示（共通認可条件表 §2・§4）。
 * 対象者の管理権限は、有効性（停止・プロフィール非表示）ではなく付与の有無で判定する。
 */
export function scopeForTarget(target: TargetRoles): AdminScope {
  return target.appManager ? "school" : "any";
}

/** 対象者の現在の管理権限をDBから読む。対象者がいなければ null。 */
export async function loadTargetRoles(reader: AccessReader, userId: string): Promise<TargetRoles | null> {
  const [target] = await reader.select({
    schoolManager: communityUsers.schoolManager,
    appManager: communityUsers.appManager,
  }).from(communityUsers).where(eq(communityUsers.userId, userId));
  return target ?? null;
}

/**
 * リクエストのセッションから利用中の閲覧者を特定し、管理操作の資格を確認する（取得APIの入口）。
 * 未認証・未完了・停止中は共通認可と同じ応答（401／403 ACCOUNT_NOT_READY／403 ACCOUNT_SUSPENDED）、資格不足は 403 FORBIDDEN。
 */
export async function requireAdminViewer(headers: Headers, scope: AdminScope, reader?: AccessReader): Promise<Viewer> {
  const viewer = await requireActiveViewer(headers, reader);
  requireAdmin(viewer, scope);
  return viewer;
}

/**
 * 管理操作の更新で `commitMutation` の `authorizeEntry` に渡す入口確認。
 * 実行者（と `resolveUserIds` で指定した対象者）の行をロックした後に最新状態を読み直して再判定するため、
 * 管理権限の解除・停止・プロフィール非表示や、対象者のアプリ管理者化と、処理中の更新を直列化できる。
 *
 * `scope` に関数を渡すと、ロック後のトランザクションで必要な区分を決められる（例：`scopeForTarget` で対象者から決める）。
 */
export function authorizeAdminEntry(
  actorId: string,
  scope: AdminScope | ((tx: AccessReader) => Promise<AdminScope>),
): (tx: AccessReader) => Promise<void> {
  return async (tx) => {
    const viewer = requireActive(await loadAccessState(tx, actorId));
    requireAdmin(viewer, typeof scope === "function" ? await scope(tx) : scope);
  };
}

/**
 * 対象者によって学校専用になる更新の区分を、ロック後の対象者の状態から決める。対象者がいなければ 404。
 * `commitMutation` の `resolveUserIds` に対象者のIDを含め、対象者の行もロックしてから使う。
 */
export function scopeForLockedTarget(targetUserId: string): (tx: AccessReader) => Promise<AdminScope> {
  return async (tx) => {
    const target = await loadTargetRoles(tx, targetUserId);
    if (!target) throw new ApiError("NOT_FOUND");
    return scopeForTarget(target);
  };
}
