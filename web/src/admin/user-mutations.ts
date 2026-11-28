import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { handoffCasesAssignedTo, restrictCasesForNewAppManager } from "@/api/report-handoff";
import { openCaseIdsOfUser, recordCaseMeasure, requireMeasureCase, requireViewableMeasureCase } from "@/api/report-measures";
import { expectedVersion, requiredReason, uuid, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive, type AccessReader } from "@/auth/access";
import { authorizeAdminEntry, requireAdmin, scopeForTarget } from "@/auth/admin";
import type { db } from "@/db/client";
import { reportCases } from "@/db/moderation-schema";
import { accountRestrictions, communityUsers, managerRoleChanges } from "@/db/schema";
import { readyAdminUser } from "./users";

export const suspensionSchema = z.strictObject({
  expectedVersion, suspended: z.boolean(), publicReason: requiredReason, internalReason: requiredReason,
  sourceCaseId: uuid.optional(),
});
export const appManagerRoleSchema = z.strictObject({ expectedVersion, assigned: z.boolean() });

async function loadTarget(tx: AccessReader, userId: string) {
  const [target] = await tx.select().from(communityUsers).where(and(readyAdminUser, eq(communityUsers.userId, userId)));
  if (!target) throw new ApiError("NOT_FOUND");
  if (target.schoolManager) throw new ApiError("FORBIDDEN");
  return target;
}

async function authorizeSuspension(tx: AccessReader, actorId: string, userId: string) {
  const target = await loadTarget(tx, userId);
  const actor = requireActive(await loadAccessState(tx, actorId));
  requireAdmin(actor, scopeForTarget(target));
  return { actor, target };
}

type MutationInput = { actorId: string; userId: string; request: MutationRequest };
type Database = Pick<typeof db, "transaction">;

export function changeSuspension(
  database: Database, { actorId, userId, request, body }: MutationInput & { body: z.infer<typeof suspensionSchema> },
) {
  const resource = { type: "user", id: userId };
  const { suspended, publicReason, internalReason, sourceCaseId } = body;
  const next = suspended ? "suspended" : "active";
  return commitMutation(database, {
    actorId, request, body,
    resolveUserIds: async () => [userId],
    authorizeEntry: authorizeAdminEntry(actorId, "any"),
    async targets(tx, original) {
      const ids = sourceCaseId === undefined ? [] : [sourceCaseId];
      if (!original && suspended) ids.push(...await openCaseIdsOfUser(tx, userId));
      return [{ stage: "case", table: reportCases, idColumn: reportCases.id, ids }];
    },
    async authorizeReplay({ tx, now }, original) {
      const { actor } = await authorizeSuspension(tx, actorId, userId);
      if (original.resource.type !== resource.type || original.resource.id !== userId) throw new ApiError("NOT_FOUND");
      if (sourceCaseId) await requireViewableMeasureCase(tx, { actor, caseId: sourceCaseId, now });
    },
    async execute(context) {
      const { tx, now } = context;
      const { actor, target } = await authorizeSuspension(tx, actorId, userId);
      if (sourceCaseId) await requireMeasureCase(tx, { actor, caseId: sourceCaseId, userId, now });
      assertExpectedVersion(target.version, body.expectedVersion);
      if (target.accountStatus === next) throw new ApiError("STATE_CONFLICT");

      const version = target.version + 1;
      await tx.update(communityUsers).set({ accountStatus: next, version }).where(eq(communityUsers.userId, userId));
      await tx.insert(accountRestrictions).values({
        actorId, userId, action: suspended ? "suspend" : "release", publicReason, internalReason, createdAt: now,
      });
      if (suspended && target.appManager) {
        await handoffCasesAssignedTo(context, { managerId: userId, trigger: "manager_suspended" });
      }
      if (sourceCaseId) {
        await recordCaseMeasure(tx, { actorId, caseId: sourceCaseId, measure: suspended
          ? { actionType: "account_suspended", before: { accountStatus: "active" }, after: { accountStatus: "suspended" } }
          : { actionType: "account_resumed", before: { accountStatus: "suspended" }, after: { accountStatus: "active" } } });
      }
      await recordAuditLog(tx, {
        action: suspended ? "account.suspended" : "account.resumed", actorId, targetId: userId, at: now, publicReason,
        before: { accountStatus: target.accountStatus, version: target.version }, after: { accountStatus: next, version },
      });
      return { status: 200, resource, version, state: next };
    },
  });
}

export function changeAppManagerRole(
  database: Database, { actorId, userId, request, body }: MutationInput & { body: z.infer<typeof appManagerRoleSchema> },
) {
  const resource = { type: "user", id: userId };
  const { assigned } = body;
  return commitMutation(database, {
    actorId, request, body,
    resolveUserIds: async () => [userId],
    authorizeEntry: authorizeAdminEntry(actorId, "school"),
    async authorizeReplay({ tx }, original) {
      await loadTarget(tx, userId);
      if (original.resource.type !== resource.type || original.resource.id !== userId) throw new ApiError("NOT_FOUND");
    },
    async execute(context) {
      const { tx, now } = context;
      const target = await loadTarget(tx, userId);
      assertExpectedVersion(target.version, body.expectedVersion);
      if (target.appManager === assigned) throw new ApiError("STATE_CONFLICT");

      const version = target.version + 1;
      await tx.update(communityUsers).set({ appManager: assigned, version }).where(eq(communityUsers.userId, userId));
      await tx.insert(managerRoleChanges).values({
        actorId, userId, beforeAppManager: target.appManager, afterAppManager: assigned, createdAt: now,
      });
      if (assigned) await restrictCasesForNewAppManager(context, { userId });
      else await handoffCasesAssignedTo(context, { managerId: userId, trigger: "manager_role_revoked" });
      await recordAuditLog(tx, {
        action: assigned ? "app_manager.assigned" : "app_manager.revoked", actorId, targetId: userId, at: now,
        before: { appManager: target.appManager, version: target.version }, after: { appManager: assigned, version },
      });
      return { status: 200, resource, version, state: assigned ? "assigned" : "revoked" };
    },
  });
}
