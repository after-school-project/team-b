import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { containing, searchText } from "@/api/list-filters";
import { createCursorCodec, parseListQuery, queryListPage } from "@/api/pagination";
import { userId as userIdSchema } from "@/api/request";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { hasAdminScope, requireAdmin, scopeForTarget } from "@/auth/admin";
import { user } from "@/db/auth-schema";
import { accountRestrictions, communityUsers, identityRecords, profileRevisions, profiles } from "@/db/schema";

export const readyAdminUser = and(
  eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"),
)!;

const displayName = sql<string | null>`case when ${communityUsers.profileState} = 'public' then ${profileRevisions.displayName} end`;

function userSource(reader: AccessReader) {
  return reader.select({
    userId: communityUsers.userId, displayName, baseRole: communityUsers.baseRole, isGraduating: communityUsers.isGraduating,
    accountStatus: communityUsers.accountStatus, profileState: communityUsers.profileState,
    schoolManager: communityUsers.schoolManager, appManager: communityUsers.appManager, version: communityUsers.version,
  }).from(communityUsers).innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, and(eq(profileRevisions.id, profiles.currentRevisionId), eq(profileRevisions.userId, profiles.userId)));
}

type UserRow = Awaited<ReturnType<typeof userSource>>[number];

function toSummary({ schoolManager, appManager, ...user }: UserRow) {
  return { ...user, roles: { schoolManager, appManager } };
}

export const adminUserBaseRoles = ["student", "alumni", "staff"] as const;
export const adminUserStatuses = ["active", "suspended"] as const;
export const adminUserManagerRoles = ["school", "app", "none"] as const;

export function parseAdminUsers(url: URL) {
  return parseListQuery(url, {
    q: searchText.optional(), baseRole: z.enum(adminUserBaseRoles).optional(),
    accountStatus: z.enum(adminUserStatuses).optional(), managerRole: z.enum(adminUserManagerRoles).optional(),
  });
}

export async function listAdminUsers(
  reader: AccessReader, viewer: Viewer, { q, baseRole, accountStatus, managerRole, cursor, limit }: ReturnType<typeof parseAdminUsers>,
) {
  requireAdmin(viewer, "any");
  const roleFilters = {
    school: eq(communityUsers.schoolManager, true),
    app: eq(communityUsers.appManager, true),
    none: and(eq(communityUsers.schoolManager, false), eq(communityUsers.appManager, false)),
  };
  const codec = createCursorCodec({
    actorId: viewer.userId, list: "admin/users", filters: { q, baseRole, accountStatus, managerRole },
    sort: "displayName:asc,userId:asc",
  }, z.tuple([z.string().nullable(), userIdSchema]));
  const last = codec.decode(cursor);
  const after = last === null ? undefined : last[0] === null
    ? and(isNull(displayName), sql`${communityUsers.userId} > ${last[1]}`)
    : or(isNull(displayName), and(isNotNull(displayName), sql`
      (${displayName}, ${communityUsers.userId}) > (${last[0]}, ${last[1]})`));

  return queryListPage({
    authorized: readyAdminUser,
    filters: and(
      q === undefined ? undefined : or(ilike(displayName, containing(q)), ilike(communityUsers.userId, containing(q))),
      baseRole === undefined ? undefined : eq(communityUsers.baseRole, baseRole),
      accountStatus === undefined ? undefined : eq(communityUsers.accountStatus, accountStatus),
      managerRole === undefined ? undefined : roleFilters[managerRole],
    ),
    after, limit,
    rows: (where, take) => userSource(reader).where(where).orderBy(sql`${displayName} asc nulls last`, asc(communityUsers.userId)).limit(take),
    count: async (where) => (await reader.select({ total: count() })
      .from(userSource(reader).where(where).as("visible_users")))[0].total,
    cursorFor: (row) => codec.encode([row.displayName, row.userId]),
    toItem: toSummary,
  });
}

export type ProfileHidingAvailability = "available" | "already_hidden" | "school_only" | "not_applicable";
export type AdminUserOverview = Awaited<ReturnType<typeof loadAdminUser>>;

export function profileHidingFor({ profileState, roles, capabilities }: AdminUserOverview): ProfileHidingAvailability {
  if (roles.schoolManager) return "not_applicable";
  if (!capabilities.canSuspend && !capabilities.canResume) return "school_only";
  return profileState === "public" ? "available" : "already_hidden";
}

export async function loadAdminUser(reader: AccessReader, viewer: Viewer, userId: string) {
  requireAdmin(viewer, "any");
  const [row] = await userSource(reader).where(and(readyAdminUser, eq(communityUsers.userId, userId)));
  if (!row) throw new ApiError("NOT_FOUND");
  const summary = toSummary(row);
  const canManage = !row.schoolManager && hasAdminScope(viewer, scopeForTarget(summary.roles));
  const suspended = row.accountStatus === "suspended";
  const [reason] = canManage && suspended ? await reader.select({
    publicReason: accountRestrictions.publicReason, internalReason: accountRestrictions.internalReason,
  }).from(accountRestrictions).where(and(eq(accountRestrictions.userId, userId), eq(accountRestrictions.action, "suspend")))
    .orderBy(desc(accountRestrictions.createdAt), desc(accountRestrictions.id)).limit(1) : [];
  const school = hasAdminScope(viewer, "school");
  return {
    ...summary,
    capabilities: {
      canSuspend: canManage && !suspended, canResume: canManage && suspended,
      canHideProfile: canManage && row.profileState === "public",
      canChangeAppManager: school && !row.schoolManager, canViewIdentity: school,
    },
    suspensionReason: reason ?? null,
  };
}

export async function loadIdentityRecord(reader: AccessReader, viewer: Viewer, userId: string) {
  requireAdmin(viewer, "school");
  const [identity] = await reader.select({
    userId: communityUsers.userId, privateRealName: identityRecords.privateRealName, schoolReference: identityRecords.schoolReference,
    email: user.email, emailVerified: user.emailVerified, verificationNote: identityRecords.verificationNote,
  }).from(communityUsers).innerJoin(user, eq(user.id, communityUsers.userId))
    .leftJoin(identityRecords, eq(identityRecords.userId, communityUsers.userId))
    .where(and(readyAdminUser, eq(communityUsers.userId, userId)));
  if (!identity) throw new ApiError("NOT_FOUND");
  return identity;
}
