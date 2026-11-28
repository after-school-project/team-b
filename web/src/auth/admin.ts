import "server-only";
import { eq } from "drizzle-orm";
import { ApiError } from "@/api/response";
import { communityUsers } from "@/db/schema";
import type { db } from "@/db/client";
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

/** 現在の管理資格と取得対象を同じDBスナップショットで確認する。 */
export function readAdmin<T>(database: Pick<typeof db, "transaction">, actorId: string,
  read: (reader: AccessReader, viewer: Viewer) => Promise<T>, scope: AdminScope = "any",
): Promise<T> {
  return database.transaction(async (tx) => {
    const viewer = requireActive(await loadAccessState(tx, actorId));
    requireAdmin(viewer, scope);
    return read(tx, viewer);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * 管理操作の更新で `commitMutation` の `authorizeEntry` に渡す入口確認。
 * 実行者の行をロックした後に最新状態を読み直し、実行者自身の管理資格だけを再判定する。
 * これにより、管理権限の解除・停止・プロフィール非表示と処理中の更新を直列化できる。
 *
 * 入口確認では対象者を参照しない。対象者の有無で拒否応答が変わらないようにし、
 * 再送キーの照合（409 IDEMPOTENCY_KEY_REUSED）を対象者の判定より先に行うため。
 * 対象者によって学校専用になる操作は、`scope` を `"any"` にして入口を通し、
 * 再送キーの照合後の `execute`・`authorizeReplay` で `requireAdminForLockedTarget` を使う。
 */
export function authorizeAdminEntry(actorId: string, scope: AdminScope): (tx: AccessReader) => Promise<void> {
  return async (tx) => {
    requireAdmin(requireActive(await loadAccessState(tx, actorId)), scope);
  };
}

/** `commitMutation` の `execute`・`authorizeReplay` が受け取る文脈のうち、ここで使うもの。 */
type LockedContext = { tx: AccessReader; requireLockedUsers: (...ids: string[]) => void };

/**
 * 対象者によって学校専用になる更新で、ロック後の対象者の状態から必要な区分を判定する。
 * `commitMutation` の `resolveUserIds` に対象者のIDを含め、`execute`・`authorizeReplay` の中で呼ぶ。
 *
 * - 対象者の行がロックされていなければ、対象者を含めてやり直す（`requireLockedUsers`）。対象者がいなければ 404。
 * - 対象者がアプリ管理者なら学校管理者のみ。足りなければ 403 FORBIDDEN。
 * - 実行者の権限は、入口通過前の Viewer ではなく、ロック後に読み直した最新状態で判定する。
 *
 * 操作ごとの追加条件に使えるよう、認可に使った実行者の Viewer と対象者の管理権限を返す。
 */
export async function requireAdminForLockedTarget(
  { tx, requireLockedUsers }: LockedContext,
  actorId: string,
  targetUserId: string,
): Promise<{ actor: Viewer; target: TargetRoles }> {
  requireLockedUsers(targetUserId);
  const target = await loadTargetRoles(tx, targetUserId);
  if (!target) throw new ApiError("NOT_FOUND");
  const actor = requireActive(await loadAccessState(tx, actorId));
  requireAdmin(actor, scopeForTarget(target));
  return { actor, target };
}
