import { and, eq } from "drizzle-orm";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { hasAdminScope, scopeForTarget } from "@/auth/admin";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";

/**
 * AD-11（ユーザー管理詳細）の利用者の基本情報。Issue #8 ⑤では画面の土台とプロフィールの非表示だけを扱う。
 * 停止・解除、権限変更、本人確認情報の照会と、取得API（API-US-01〜04・06）は #16 で追加する。
 */

/** プロフィールの非表示を行えるか、行えない理由。 */
export type ProfileHidingAvailability =
  | "available"
  /** 既に非表示。 */
  | "already_hidden"
  /** アプリ管理者が対象のため、学校管理者だけが操作できる。 */
  | "school_only"
  /** 学校管理者のプロフィールは管理操作の対象外（CR-05）。 */
  | "not_applicable";

/** API設計書 §12 AdminUserSummary の項目と、非表示の操作の可否。本人確認情報・停止理由は含めない。 */
export type AdminUserOverview = {
  userId: string;
  displayName: string;
  baseRole: Viewer["baseRole"];
  isGraduating: boolean;
  accountStatus: "active" | "suspended";
  profileState: "public" | "hidden";
  roles: { schoolManager: boolean; appManager: boolean };
  version: number;
  profileHiding: ProfileHidingAvailability;
};

function profileHidingFor(viewer: Viewer, target: Pick<AdminUserOverview, "roles" | "profileState">): ProfileHidingAvailability {
  if (target.roles.schoolManager) return "not_applicable";
  if (!hasAdminScope(viewer, scopeForTarget(target.roles))) return "school_only";
  return target.profileState === "public" ? "available" : "already_hidden";
}

/** 利用者の基本情報。発行準備中の利用者は存在しないものとして404（公開プロフィールと同じ）。 */
export async function loadAdminUser(reader: AccessReader, viewer: Viewer, userId: string): Promise<AdminUserOverview> {
  const [row] = await reader.select({
    userId: communityUsers.userId,
    displayName: profileRevisions.displayName,
    baseRole: communityUsers.baseRole,
    isGraduating: communityUsers.isGraduating,
    accountStatus: communityUsers.accountStatus,
    profileState: communityUsers.profileState,
    schoolManager: communityUsers.schoolManager,
    appManager: communityUsers.appManager,
    version: communityUsers.version,
  }).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId),
    ))
    .where(and(
      eq(communityUsers.userId, userId),
      eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"),
    ));
  if (!row) throw new ApiError("NOT_FOUND");
  const { schoolManager, appManager, ...user } = row;
  const roles = { schoolManager, appManager };
  return { ...user, roles, profileHiding: profileHidingFor(viewer, { roles, profileState: row.profileState }) };
}
