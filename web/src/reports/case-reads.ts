import { and, asc, count, desc, eq, getTableColumns, ne, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { userId, uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive, type AccessReader, type Viewer } from "@/auth/access";
import { requireAdmin } from "@/auth/admin";
import type { db } from "@/db/client";
import { evidenceSnapshots, reportActions, reportCaseEvidence, reportCases, reports, reportTargets } from "@/db/moderation-schema";
import { communityUsers, profileRevisions, profiles } from "@/db/schema";
import {
  caseSource, eligibleManager, publicDisplayName, requiresSchoolAssignee, requireViewableCase, viewableCases,
} from "./case-access";
import { casePriorities, caseStatuses, reportTargetTypes } from "./labels";

/** 案件の認可・証拠の削除状態・一覧の件数を、同じDBスナップショットで確認する。 */
export function readCases<T>(database: Pick<typeof db, "transaction">, actorId: string,
  read: (reader: AccessReader, viewer: Viewer) => Promise<T>,
  scope: "any" | "school" = "any",
): Promise<T> {
  return database.transaction(async (tx) => {
    const viewer = requireActive(await loadAccessState(tx, actorId));
    requireAdmin(viewer, scope);
    return read(tx, viewer);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function parseCaseList(url: URL, handoffs = false) {
  return parseListQuery(url, {
    status: z.enum([...caseStatuses, "all"]).default(handoffs ? "all" : "unhandled"), priority: z.enum(casePriorities).optional(),
    assigneeId: userId.optional(), targetType: z.enum(reportTargetTypes).optional(),
  });
}

export function parseCaseItems(url: URL) { return parseListQuery(url, {}); }
export type CaseListQuery = ReturnType<typeof parseCaseList>;
type ItemQuery = ReturnType<typeof parseCaseItems>;

function datePage(viewer: Viewer, list: string, filters: Record<string, string | undefined>, cursor: string | undefined,
  dateColumn: SQLWrapper, idColumn: SQLWrapper, dateField: string, direction: "asc" | "desc" = "desc",
) {
  const codec = createCursorCodec({ actorId: viewer.userId, list, filters, sort: `${dateField}:${direction},id:${direction}` },
    z.tuple([z.string(), uuid]));
  const last = codec.decode(cursor);
  const compare = direction === "asc" ? sql`>` : sql`<`;
  return {
    after: last ? sql`(${dateColumn}, ${idColumn}) ${compare} (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
    cursorFor: (row: { cursorAt: string; id: string }) => codec.encode([row.cursorAt, row.id]),
  };
}

function publicAuthor(id: string, displayName: string | null) {
  return { userId: id, displayName: displayName ?? "表示名非公開" };
}

function toCaseSummary(row: Awaited<ReturnType<typeof requireViewableCase>>) {
  return {
    id: row.id,
    target: { type: row.targetType, id: row.questionId ?? row.responseId ?? row.subjectUserId,
      subjectUserId: row.subjectUserId, label: row.label, sourceState: row.sourceState },
    status: row.status, priority: row.priority,
    assignee: row.assigneeId === null ? null : publicAuthor(row.assigneeId, row.assigneeName),
    handoffPending: row.handoffPending, schoolOnly: row.schoolOnly, reportCount: row.reportCount, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null,
  };
}

export async function listCases(reader: AccessReader, viewer: Viewer, query: CaseListQuery, handoffs = false) {
  if (handoffs) requireAdmin(viewer, "school");
  const { status, priority, assigneeId, targetType } = query;
  const dateColumn = handoffs ? reportCases.createdAt : reportCases.updatedAt;
  const orderBy = handoffs ? asc : desc;
  return queryListPage({
    ...datePage(viewer, handoffs ? "report-handoffs" : "report-cases", { status, priority, assigneeId, targetType },
      query.cursor, dateColumn, reportCases.id, handoffs ? "createdAt" : "updatedAt", handoffs ? "asc" : "desc"),
    authorized: viewableCases(viewer),
    filters: and(
      status === "all" ? undefined : eq(reportCases.status, status),
      priority === undefined ? undefined : eq(reportCases.priority, priority),
      assigneeId === undefined ? undefined : eq(reportCases.assigneeId, assigneeId),
      targetType === undefined ? undefined : eq(reportTargets.kind, targetType),
      handoffs ? and(eq(reportCases.handoffPending, true), ne(reportCases.status, "closed")) : undefined,
    ),
    limit: query.limit,
    rows: (where, take) => caseSource(reader, dateColumn).where(where).orderBy(orderBy(dateColumn), orderBy(reportCases.id)).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(caseSource(reader).where(where).as("visible_cases")))[0].total,
    toItem: toCaseSummary,
  });
}

export async function loadCase(reader: AccessReader, viewer: Viewer, caseId: string) {
  const row = await requireViewableCase(reader, viewer, caseId);
  const open = row.status !== "closed";
  return {
    ...toCaseSummary(row),
    capabilities: { canUpdate: open, canAssign: open, canAddNote: open,
      canViewEvidence: row.sourceState !== "deleted" || viewer.roles.schoolManager, canViewIdentity: viewer.roles.schoolManager },
  };
}

const actionState = z.object({
  status: z.enum(caseStatuses), priority: z.enum(casePriorities), assigneeId: userId.nullable(), handoffPending: z.boolean(),
  trigger: z.enum(["manager_profile_hidden", "manager_suspended", "manager_role_revoked", "target_deleted", "subject_became_app_manager"]),
  profileState: z.enum(["public", "hidden"]), publicationState: z.enum(["public", "hidden"]), schoolOnly: z.boolean(),
}).partial();

function projectActionState(value: unknown) {
  const projected = actionState.safeParse(value);
  return projected.success ? projected.data : null;
}

export async function listCaseActions(reader: AccessReader, viewer: Viewer, caseId: string, query: ItemQuery) {
  const parent = await requireViewableCase(reader, viewer, caseId);
  const redacted = parent.sourceDeleted && !viewer.roles.schoolManager;
  return queryListPage({
    ...datePage(viewer, "report-case-actions", { caseId }, query.cursor, reportActions.createdAt, reportActions.id, "createdAt"),
    authorized: eq(reportActions.caseId, caseId), limit: query.limit,
    rows: (where, take) => reader.select({
      ...getTableColumns(reportActions), note: redacted ? sql<null>`null` : reportActions.note,
      actorName: publicDisplayName(reader, reportActions.actorId), cursorAt: cursorTimestamp(reportActions.createdAt),
    }).from(reportActions).where(where).orderBy(desc(reportActions.createdAt), desc(reportActions.id)).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(reportActions).where(where))[0].total,
    toItem: (row) => ({
      id: row.id, actor: row.actorId === null ? null : publicAuthor(row.actorId, row.actorName), systemAction: row.systemAction,
      actionType: row.actionType, beforeState: projectActionState(row.beforeState), afterState: projectActionState(row.afterState),
      note: row.note, noteRedacted: redacted, createdAt: row.createdAt.toISOString(),
    }),
  });
}

export async function listCaseReports(reader: AccessReader, viewer: Viewer, caseId: string, query: ItemQuery) {
  const parent = await requireViewableCase(reader, viewer, caseId);
  const redacted = parent.sourceDeleted && !viewer.roles.schoolManager;
  return queryListPage({
    ...datePage(viewer, "report-case-reports", { caseId }, query.cursor, reports.createdAt, reports.id, "createdAt"),
    authorized: eq(reports.caseId, caseId), limit: query.limit,
    rows: (where, take) => reader.select({
      id: reports.id, reason: reports.reasonCode, detail: redacted ? sql<null>`null` : reports.detail, reporterId: reports.reporterId,
      reporterName: publicDisplayName(reader, reports.reporterId), createdAt: reports.createdAt, cursorAt: cursorTimestamp(reports.createdAt),
    }).from(reports).where(where).orderBy(desc(reports.createdAt), desc(reports.id)).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(reports).where(where))[0].total,
    toItem: (row) => ({ id: row.id, reason: row.reason, detail: row.detail, detailRedacted: redacted,
      reporter: publicAuthor(row.reporterId, row.reporterName), createdAt: row.createdAt.toISOString() }),
  });
}

async function evidenceAccess(reader: AccessReader, viewer: Viewer, caseId: string) {
  const parent = await requireViewableCase(reader, viewer, caseId);
  if (parent.sourceDeleted && !viewer.roles.schoolManager) throw new ApiError("NOT_FOUND");
  const related = alias(reportCases, "related_cases");
  // その証拠にリンクされた案件だけでなく、同じ対象の全案件を数える。
  const expiresAt = parent.sourceDeleted ? sql<string | null>`(${reader.select({
    expiresAt: sql`CASE WHEN bool_and(${related.status} = 'closed')
      THEN to_char((max(${related.closedAt}) + interval '180 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`,
  }).from(related).where(eq(related.targetId, parent.targetId))})` : sql<null>`null`;
  return {
    parent, expiresAt,
    authorized: and(eq(reportCaseEvidence.caseId, caseId), eq(evidenceSnapshots.targetId, parent.targetId),
      sql`(${expiresAt} IS NULL OR (${expiresAt})::timestamptz > now())`)!,
  };
}

export async function listCaseEvidence(reader: AccessReader, viewer: Viewer, caseId: string, query: ItemQuery) {
  const { parent, expiresAt, authorized } = await evidenceAccess(reader, viewer, caseId);
  return queryListPage({
    ...datePage(viewer, "report-case-evidence", { caseId }, query.cursor, evidenceSnapshots.capturedAt, evidenceSnapshots.id, "capturedAt"),
    authorized, limit: query.limit,
    rows: (where, take) => reader.select({
      id: evidenceSnapshots.id, capturedAt: evidenceSnapshots.capturedAt, targetType: reportTargets.kind,
      expiresAt, cursorAt: cursorTimestamp(evidenceSnapshots.capturedAt),
    }).from(evidenceSnapshots).innerJoin(reportCaseEvidence, eq(reportCaseEvidence.evidenceId, evidenceSnapshots.id))
      .innerJoin(reportTargets, eq(reportTargets.id, evidenceSnapshots.targetId)).where(where)
      .orderBy(desc(evidenceSnapshots.capturedAt), desc(evidenceSnapshots.id)).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(evidenceSnapshots)
      .innerJoin(reportCaseEvidence, eq(reportCaseEvidence.evidenceId, evidenceSnapshots.id)).where(where))[0].total,
    toItem: (row) => ({ id: row.id, capturedAt: row.capturedAt.toISOString(), targetType: row.targetType,
      sourceDeleted: parent.sourceDeleted, retentionExpiresAt: row.expiresAt }),
  });
}

export async function loadCaseEvidence(reader: AccessReader, viewer: Viewer, caseId: string, evidenceId: string) {
  const { parent, expiresAt, authorized } = await evidenceAccess(reader, viewer, caseId);
  const [row] = await reader.select({
    id: evidenceSnapshots.id, capturedAt: evidenceSnapshots.capturedAt, targetType: reportTargets.kind,
    expiresAt, content: evidenceSnapshots.snapshot,
  }).from(evidenceSnapshots).innerJoin(reportCaseEvidence, eq(reportCaseEvidence.evidenceId, evidenceSnapshots.id))
    .innerJoin(reportTargets, eq(reportTargets.id, evidenceSnapshots.targetId))
    .where(and(authorized, eq(evidenceSnapshots.id, evidenceId)));
  if (!row) throw new ApiError("NOT_FOUND");
  return { id: row.id, capturedAt: row.capturedAt.toISOString(), targetType: row.targetType, sourceDeleted: parent.sourceDeleted,
    retentionExpiresAt: row.expiresAt, content: row.content };
}

export async function listAssigneeCandidates(reader: AccessReader, viewer: Viewer, caseId: string, query: ItemQuery) {
  const parent = await requireViewableCase(reader, viewer, caseId);
  if (parent.status === "closed") throw new ApiError("CASE_CLOSED");
  const codec = createCursorCodec({ actorId: viewer.userId, list: "report-case-candidates", filters: { caseId }, sort: "userId:asc" },
    z.tuple([userId]));
  const last = codec.decode(query.cursor);
  return queryListPage({
    authorized: and(eligibleManager(requiresSchoolAssignee(parent)), ne(communityUsers.userId, parent.subjectUserId))!,
    after: last ? sql`${communityUsers.userId} > ${last[0]}` : undefined,
    limit: query.limit,
    rows: (where, take) => reader.select({
      userId: communityUsers.userId, displayName: sql<string | null>`CASE WHEN ${communityUsers.profileState} = 'public'
        THEN ${profileRevisions.displayName} ELSE NULL END`,
      schoolManager: communityUsers.schoolManager, appManager: communityUsers.appManager, userVersion: communityUsers.version,
    }).from(communityUsers).leftJoin(profiles, eq(profiles.userId, communityUsers.userId))
      .leftJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
      .where(where).orderBy(communityUsers.userId).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(communityUsers).where(where))[0].total,
    cursorFor: (row) => codec.encode([row.userId]),
    toItem: ({ schoolManager, appManager, ...row }) => ({ ...row, roles: { schoolManager, appManager } }),
  });
}
