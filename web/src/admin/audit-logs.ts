import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { projectAuditState } from "@/api/audit-log";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { requireAdmin } from "@/auth/admin";
import { auditLogs } from "@/db/moderation-schema";
import { publicDisplayName } from "@/reports/case-access";

export function parseAuditLogs(url: URL) {
  return parseListQuery(url, {});
}

function retainedAuditLogs() {
  return sql`${auditLogs.createdAt} + interval '1 year' > now()`;
}

function logSource(reader: AccessReader) {
  return reader.select({
    id: auditLogs.id, actorId: auditLogs.actorId, actorName: publicDisplayName(reader, auditLogs.actorId),
    systemAction: auditLogs.systemAction, actionType: auditLogs.actionType,
    targetType: auditLogs.targetType, targetId: auditLogs.targetId,
    beforeState: auditLogs.beforeState, afterState: auditLogs.afterState, publicReason: auditLogs.publicReason,
    createdAt: auditLogs.createdAt, cursorAt: cursorTimestamp(auditLogs.createdAt),
  }).from(auditLogs);
}

function toAuditLog(row: Awaited<ReturnType<typeof logSource>>[number]) {
  return {
    id: row.id,
    actor: row.actorId === null ? null : { userId: row.actorId, displayName: row.actorName ?? "表示名非公開" },
    systemAction: row.systemAction, actionType: row.actionType, target: { type: row.targetType, id: row.targetId },
    beforeState: projectAuditState(row.actionType, row.beforeState), afterState: projectAuditState(row.actionType, row.afterState),
    publicReason: row.publicReason, createdAt: row.createdAt.toISOString(),
  };
}

export type AuditLog = ReturnType<typeof toAuditLog>;

export async function listAuditLogs(reader: AccessReader, viewer: Viewer, { cursor, limit }: ReturnType<typeof parseAuditLogs>) {
  requireAdmin(viewer, "school");
  const codec = createCursorCodec({
    actorId: viewer.userId, list: "admin/audit-logs", filters: {}, sort: "createdAt:desc,id:desc",
  }, z.tuple([z.string(), uuid]));
  const last = codec.decode(cursor);
  return queryListPage({
    authorized: retainedAuditLogs(), limit,
    after: last === null ? undefined : sql`
      (${auditLogs.createdAt}, ${auditLogs.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`,
    rows: (where, take) => logSource(reader).where(where).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(take),
    count: async (where) => (await reader.select({ total: count() }).from(auditLogs).where(where))[0].total,
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: toAuditLog,
  });
}

export async function loadAuditLog(reader: AccessReader, viewer: Viewer, logId: string) {
  requireAdmin(viewer, "school");
  const [row] = await logSource(reader).where(and(retainedAuditLogs(), eq(auditLogs.id, logId)));
  if (!row) throw new ApiError("NOT_FOUND");
  return toAuditLog(row);
}
