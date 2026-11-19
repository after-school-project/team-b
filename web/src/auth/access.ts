import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ApiError } from "@/api/response";
import { accountRestrictions, communityUsers } from "@/db/schema";
import { getAuthSession, type AuthSession } from "./server";

/**
 * 全機能共通の認可サービス（Issue #7 ②の中核）。
 *
 * 判定は共通認可条件表 §1 の順に行う。
 * 1. DB上で有効な認証セッション（なければ 401 AUTH_REQUIRED）
 * 2. 発行完了・学校確認済み（満たさなければ 403 ACCOUNT_NOT_READY）
 * 3. 停止中でない（停止中は本人向け案内だけを返し、その他は 403 ACCOUNT_SUSPENDED）
 * 4. 以降のプロフィール状態・所属・管理権限は、毎回DBから読んだ Viewer で各処理が判定する
 *
 * 利用者IDはセッションだけから得る。リクエストの actorId・所属・権限は参照しない。
 * 結果は要求ごとに計算し、利用者間で共有するキャッシュへ保存しない。
 */

/** select だけを使う。通常のDBクライアントとトランザクションの両方を受け付ける。 */
export type AccessReader = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, "select">;

/** 停止していない、利用資格確認済みの利用者の最新状態。 */
export type Viewer = {
  userId: string;
  baseRole: "student" | "alumni" | "staff";
  isGraduating: boolean;
  profileState: "public" | "hidden";
  userVersion: number;
  roles: { schoolManager: boolean; appManager: boolean };
};

export type AccessState =
  | { access: "active"; viewer: Viewer }
  | { access: "suspended"; userId: string };

export type RequestAccess = { session: AuthSession; state: AccessState };

async function defaultReader(): Promise<AccessReader> {
  return (await import("@/db/client")).db;
}

/**
 * 利用者IDに対応する最新の利用状態をDBから読む。
 * 認証セッションの確認は呼び出し側で済ませる（トランザクション内の入口確認からも使う）。
 */
export async function loadAccessState(reader: AccessReader, userId: string): Promise<AccessState> {
  const [user] = await reader.select({
    userId: communityUsers.userId,
    baseRole: communityUsers.baseRole,
    isGraduating: communityUsers.isGraduating,
    schoolManager: communityUsers.schoolManager,
    appManager: communityUsers.appManager,
    accountStatus: communityUsers.accountStatus,
    profileState: communityUsers.profileState,
    eligibilityStatus: communityUsers.eligibilityStatus,
    provisioningStatus: communityUsers.provisioningStatus,
    version: communityUsers.version,
  }).from(communityUsers).where(eq(communityUsers.userId, userId));

  if (!user || user.provisioningStatus !== "ready" || user.eligibilityStatus !== "verified") {
    throw new ApiError("ACCOUNT_NOT_READY");
  }

  // 業務APIは停止状態だけで拒否する。本人向けの理由は /me だけが loadPublicSuspensionReason で読む。
  if (user.accountStatus === "suspended") return { access: "suspended", userId };

  return {
    access: "active",
    viewer: {
      userId: user.userId,
      baseRole: user.baseRole,
      isGraduating: user.isGraduating,
      profileState: user.profileState,
      userVersion: user.version,
      roles: { schoolManager: user.schoolManager, appManager: user.appManager },
    },
  };
}

/**
 * 停止中の本人へ示す最新の停止理由を読む。内部理由は読まない。
 * 停止は本人向け理由と同時に記録する契約のため、記録がなければ不整合として扱い、理由を推測で補わない。
 */
export async function loadPublicSuspensionReason(reader: AccessReader, userId: string): Promise<string> {
  const [restriction] = await reader.select({ publicReason: accountRestrictions.publicReason })
    .from(accountRestrictions)
    .where(and(eq(accountRestrictions.userId, userId), eq(accountRestrictions.action, "suspend")))
    .orderBy(desc(accountRestrictions.createdAt), desc(accountRestrictions.id))
    .limit(1);
  if (!restriction) throw new Error("停止中の利用者に本人向けの停止理由がありません。");
  return restriction.publicReason;
}

/** リクエストのセッションから利用者を特定し、最新の利用状態を返す。 */
export async function resolveRequestAccess(
  headers: Headers,
  reader?: AccessReader,
): Promise<RequestAccess> {
  const session = await getAuthSession(headers);
  if (!session) throw new ApiError("AUTH_REQUIRED");
  const state = await loadAccessState(reader ?? await defaultReader(), session.user.id);
  return { session, state };
}

/** 停止中を 403 ACCOUNT_SUSPENDED として拒否し、利用中の Viewer を返す。 */
export function requireActive(state: AccessState): Viewer {
  if (state.access !== "active") throw new ApiError("ACCOUNT_SUSPENDED");
  return state.viewer;
}

/** 業務APIの入口。セッション確認から停止判定までを行い、利用中の Viewer を返す。 */
export async function requireActiveViewer(headers: Headers, reader?: AccessReader): Promise<Viewer> {
  return requireActive((await resolveRequestAccess(headers, reader)).state);
}

/** プロフィール非表示中の新規投稿・既存編集などを 403 PROFILE_WRITE_RESTRICTED として拒否する。 */
export function requireProfileWritable(viewer: Viewer): void {
  if (viewer.profileState !== "public") throw new ApiError("PROFILE_WRITE_RESTRICTED");
}

/**
 * 管理エリアに入れるか。学校管理者、または停止・プロフィール非表示・権限解除の制限がないアプリ管理者。
 * 操作ごとの学校専用・両管理者共通の区別は各管理機能で判定する。
 */
export function canEnterAdmin(viewer: Viewer): boolean {
  return viewer.roles.schoolManager || (viewer.roles.appManager && viewer.profileState === "public");
}

/** 新規投稿・既存編集が可能なプロフィール状態か。所属ごとの投稿可否は各機能で判定する。 */
export function canWriteContent(viewer: Viewer): boolean {
  return viewer.profileState === "public";
}

/**
 * `commitMutation` の `authorizeEntry` に渡す入口確認。
 * 実行者の行をロックした後に最新状態を読み直し、停止・権限変更と更新を直列化する。
 */
export function authorizeActiveEntry(
  actorId: string,
  options: { profileWritable?: boolean } = {},
): (tx: AccessReader) => Promise<void> {
  return async (tx) => {
    const viewer = requireActive(await loadAccessState(tx, actorId));
    if (options.profileWritable) requireProfileWritable(viewer);
  };
}

export type MeState =
  | {
    access: "active";
    userId: string;
    baseRole: Viewer["baseRole"];
    isGraduating: boolean;
    profileState: Viewer["profileState"];
    userVersion: number;
    roles: Viewer["roles"];
    capabilities: { canEnterAdmin: boolean; canWriteContent: boolean };
    sessionExpiresAt: string;
  }
  | { access: "suspended"; publicReason: string };

/**
 * API設計書 §4 の MeState へ投影する。停止中は本人向け理由だけを返す。
 * 停止中の場合は loadPublicSuspensionReason で読んだ理由を渡す。
 */
export function toMeState({ session, state }: RequestAccess, publicReason?: string): MeState {
  if (state.access === "suspended") {
    if (publicReason === undefined) throw new Error("停止中の MeState には本人向けの停止理由が必要です。");
    return { access: "suspended", publicReason };
  }
  const { viewer } = state;
  return {
    access: "active",
    userId: viewer.userId,
    baseRole: viewer.baseRole,
    isGraduating: viewer.isGraduating,
    profileState: viewer.profileState,
    userVersion: viewer.userVersion,
    roles: { schoolManager: viewer.roles.schoolManager, appManager: viewer.roles.appManager },
    capabilities: { canEnterAdmin: canEnterAdmin(viewer), canWriteContent: canWriteContent(viewer) },
    sessionExpiresAt: session.session.expiresAt.toISOString(),
  };
}

/** API-COM-01 の本体。停止中だけ本人向けの停止理由を追加で読む。 */
export async function resolveMeState(headers: Headers, reader?: AccessReader): Promise<MeState> {
  const database = reader ?? await defaultReader();
  const access = await resolveRequestAccess(headers, database);
  const publicReason = access.state.access === "suspended"
    ? await loadPublicSuspensionReason(database, access.state.userId)
    : undefined;
  return toMeState(access, publicReason);
}
