import { and, eq, getTableColumns, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cursorTimestamp } from "@/api/pagination";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { reportCases, reports, reportTargets } from "@/db/moderation-schema";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";

const sourceDeleted = sql<boolean>`(${qaQuestions.deletedAt} IS NOT NULL OR ${qaResponses.deletedAt} IS NOT NULL)`;
const sourceState = sql<"public" | "hidden" | "deleted">`CASE
  WHEN ${sourceDeleted} THEN 'deleted'
  WHEN ${qaQuestions.forcedHiddenAt} IS NOT NULL OR ${qaResponses.forcedHiddenAt} IS NOT NULL
    OR (${reportTargets.kind} = 'profile' AND ${communityUsers.profileState} = 'hidden') THEN 'hidden'
  ELSE 'public' END`;

export function caseSource(reader: AccessReader) {
  return reader.select({
    ...getTableColumns(reportCases), targetType: reportTargets.kind, subjectUserId: communityUsers.userId,
    subjectAppManager: communityUsers.appManager, questionId: reportTargets.questionId, responseId: reportTargets.responseId,
    sourceDeleted: sourceDeleted.as("source_deleted"), sourceState: sourceState.as("source_state"),
    label: sql<string | null>`CASE WHEN ${sourceState} = 'public' THEN CASE ${reportTargets.kind}
      WHEN 'question' THEN ${qaQuestions.title} WHEN 'response' THEN ${qaResponses.authorLabel}
      ELSE ${publicDisplayName(reader, communityUsers.userId)} END ELSE NULL END`.as("label"),
    assigneeName: publicDisplayName(reader, reportCases.assigneeId).as("assignee_name"),
    reportCount: sql<number>`(${reader.select({ total: sql`count(*)::int` }).from(reports)
      .where(eq(reports.caseId, reportCases.id))})`.as("report_count"),
    cursorAt: cursorTimestamp(reportCases.updatedAt).as("cursor_at"),
  }).from(reportCases)
    .innerJoin(reportTargets, eq(reportTargets.id, reportCases.targetId))
    .leftJoin(qaQuestions, eq(qaQuestions.id, reportTargets.questionId))
    .leftJoin(qaResponses, eq(qaResponses.id, reportTargets.responseId))
    .innerJoin(communityUsers, eq(communityUsers.userId,
      sql`coalesce(${reportTargets.subjectUserId}, ${qaQuestions.authorId}, ${qaResponses.authorId})`));
}

/** 一覧・件数・詳細・措置で同じ閲覧範囲と案件期限を使う。 */
export function viewableCases(viewer: Pick<Viewer, "roles">, now?: Date): SQL {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  return and(
    sql`(${reportCases.closedAt} IS NULL OR ${reportCases.closedAt} + interval '1 year' > ${at})`,
    viewer.roles.schoolManager ? undefined : and(
      eq(reportCases.schoolOnly, false), eq(reportCases.handoffPending, false), eq(communityUsers.appManager, false),
    ),
  )!;
}

export async function requireViewableCase(reader: AccessReader, viewer: Pick<Viewer, "roles">, caseId: string, now?: Date) {
  const [row] = await caseSource(reader).where(and(eq(reportCases.id, caseId), viewableCases(viewer, now)));
  if (!row) throw new ApiError("NOT_FOUND");
  return row;
}

export function eligibleManager(schoolOnly: boolean): SQL {
  return and(
    eq(communityUsers.provisioningStatus, "ready"), eq(communityUsers.eligibilityStatus, "verified"),
    eq(communityUsers.accountStatus, "active"),
    schoolOnly ? eq(communityUsers.schoolManager, true) : or(
      eq(communityUsers.schoolManager, true), and(eq(communityUsers.appManager, true), eq(communityUsers.profileState, "public")),
    ),
  )!;
}

export function requiresSchoolAssignee(row: Awaited<ReturnType<typeof requireViewableCase>>): boolean {
  return row.schoolOnly || row.subjectAppManager || row.sourceDeleted;
}

/** 現在の公開版の表示名を取得する。非表示中は利用者IDだけを表示できる。 */
export function publicDisplayName(reader: AccessReader, userId: SQLWrapper) {
  const namedUser = alias(communityUsers, "named_user");
  return sql<string | null>`(${reader.select({ name: profileRevisions.displayName }).from(profiles)
    .innerJoin(namedUser, and(eq(namedUser.userId, profiles.userId), eq(namedUser.profileState, "public")))
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(sql`${profiles.userId} = ${userId}`)})`;
}
