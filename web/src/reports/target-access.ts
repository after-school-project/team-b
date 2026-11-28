import { and, eq } from "drizzle-orm";
import type { AccessReader } from "@/auth/access";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";

export function canReportOther(actorId: string, userId: string, schoolManager: boolean): boolean {
  return actorId !== userId && !schoolManager;
}

export async function findReportableUser(reader: AccessReader, actorId: string, userId: string, publicProfile: boolean) {
  if (actorId === userId) return null;
  const [user] = await reader.select({ appManager: communityUsers.appManager }).from(communityUsers)
    .innerJoin(profiles, eq(profiles.userId, communityUsers.userId))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(and(
      eq(communityUsers.userId, userId), eq(communityUsers.schoolManager, false),
      eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"),
      publicProfile ? eq(communityUsers.profileState, "public") : undefined,
    ));
  return user ?? null;
}
