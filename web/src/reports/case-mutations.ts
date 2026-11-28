import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { lockedCaseTime } from "@/api/report-evidence";
import { expectedVersion, requiredReason, userId, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive } from "@/auth/access";
import { authorizeAdminEntry } from "@/auth/admin";
import { reportActions, reportCases } from "@/db/moderation-schema";
import { communityUsers } from "@/db/schema";
import { caseSource, eligibleManager, requireViewableCase, requiresSchoolAssignee } from "./case-access";
import { casePriorities, caseStatuses } from "./labels";

export const casePatchSchema = z.strictObject({
  expectedVersion, status: z.enum(caseStatuses).optional(), priority: z.enum(casePriorities).optional(),
}).refine((input) => input.status !== undefined || input.priority !== undefined);
export const assignmentSchema = z.strictObject({ expectedVersion, assigneeId: userId });
export const caseNoteSchema = z.strictObject({ expectedVersion, note: requiredReason });

type Change = { kind: "patch"; input: z.output<typeof casePatchSchema> }
  | { kind: "assignment"; input: z.output<typeof assignmentSchema> }
  | { kind: "note"; input: z.output<typeof caseNoteSchema> };
type Context = Parameters<Parameters<typeof commitMutation>[1]["execute"]>[0];

export function changeReportCase(
  database: Parameters<typeof commitMutation>[0], actorId: string, caseId: string, change: Change, request: MutationRequest,
) {
  const candidateId = change.kind === "assignment" ? change.input.assigneeId : undefined;

  async function authorize({ tx, now, requireLockedUsers }: Context) {
    const viewer = requireActive(await loadAccessState(tx, actorId));
    const row = await requireViewableCase(tx, viewer, caseId, now);
    requireLockedUsers(row.subjectUserId);
    if (row.assigneeId) requireLockedUsers(row.assigneeId);
    return row;
  }

  return commitMutation(database, {
    actorId, request, body: change.input,
    authorizeEntry: authorizeAdminEntry(actorId, "any"),
    async resolveUserIds(tx) {
      const [row] = await caseSource(tx).where(eq(reportCases.id, caseId));
      return [row?.subjectUserId, row?.assigneeId, candidateId].filter((id): id is string => typeof id === "string");
    },
    async targets() {
      return [{ stage: "case", table: reportCases, idColumn: reportCases.id, ids: [caseId] }];
    },
    async authorizeReplay(context) { await authorize(context); },
    async execute(context) {
      const { tx, requireLockedUsers } = context;
      const row = await authorize(context);
      if (row.status === "closed") throw new ApiError("CASE_CLOSED");
      assertExpectedVersion(row.version, change.input.expectedVersion);

      const status = change.kind === "patch" ? change.input.status ?? row.status : row.status;
      const priority = change.kind === "patch" ? change.input.priority ?? row.priority : row.priority;
      const closing = status === "closed";
      const assigneeId = candidateId ?? (closing && row.handoffPending ? actorId : row.assigneeId);
      const handoffPending = assigneeId === null;
      const version = row.version + 1;
      const changed = status !== row.status || priority !== row.priority || assigneeId !== row.assigneeId;
      if (!changed && change.kind !== "note") throw new ApiError("STATE_CONFLICT");

      if (assigneeId !== null) {
        const [eligible] = await tx.select({ id: communityUsers.userId }).from(communityUsers).where(and(
          eq(communityUsers.userId, assigneeId), eligibleManager(requiresSchoolAssignee(row)),
        ));
        if (!eligible || assigneeId === row.subjectUserId) throw new ApiError("STATE_CONFLICT");
        requireLockedUsers(assigneeId);
      }

      const before = { status: row.status, priority: row.priority, assigneeId: row.assigneeId, handoffPending: row.handoffPending };
      const after = { status, priority, assigneeId, handoffPending };
      const actionType = closing ? "case_closed" : change.kind === "patch" ? "case_updated"
        : change.kind === "assignment" ? (row.handoffPending ? "handoff_resolved" : "assignee_changed") : "note_added";
      const updatedAt = await lockedCaseTime(tx);
      await tx.update(reportCases).set({ ...after, version, updatedAt, closedAt: closing ? updatedAt : null })
        .where(eq(reportCases.id, caseId));
      await tx.insert(reportActions).values({
        caseId, actorId, actionType, createdAt: updatedAt,
        beforeState: changed ? before : null, afterState: changed ? after : null,
        note: change.kind === "note" ? change.input.note : null,
      });
      if (closing) await recordAuditLog(tx, {
        action: "report_case.closed", actorId, targetId: caseId, before: { ...before, version: row.version },
        after: { ...after, version }, at: updatedAt,
      });
      return { status: 200, resource: { type: "report_case", id: caseId }, version, state: status };
    },
  });
}
