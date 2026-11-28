import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAuditLog } from "@/api/audit-log";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { recordNotification } from "@/api/notifications";
import { preserveEvidence } from "@/api/report-evidence";
import { recordCaseMeasure, requireQaMeasureCase } from "@/api/report-measures";
import { expectedVersion, optionalReason, uuid, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import type { AccessReader } from "@/auth/access";
import { authorizeAdminEntry, requireAdminForLockedTarget } from "@/auth/admin";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { reportCases } from "@/db/moderation-schema";

export const qaVisibilitySchema = z.strictObject({
  expectedVersion,
  visibility: z.enum(["hidden", "public"]),
  reason: optionalReason,
  sourceCaseId: uuid.optional(),
}).refine(({ visibility, reason }) => visibility === "public" || reason !== null, {
  path: ["reason"], message: "本人向け理由を入力してください。",
});

type Target = { type: "question" | "response"; id: string };
type Database = Parameters<typeof commitMutation>[0];
type LockedContext = Parameters<Parameters<typeof commitMutation>[1]["execute"]>[0];

function readPost(reader: AccessReader, target: Target) {
  const table = target.type === "question" ? qaQuestions : qaResponses;
  return reader.select({
    authorId: table.authorId, version: table.version, forcedHiddenAt: table.forcedHiddenAt, deletedAt: table.deletedAt,
  }).from(table).where(eq(table.id, target.id));
}

/** API-AQ-01・02。投稿、証拠、措置履歴、監査と本人への通知を同じ更新で確定する。 */
export function changeQaVisibility(
  database: Database, actorId: string, target: Target, input: z.output<typeof qaVisibilitySchema>, request: MutationRequest,
) {
  const table = target.type === "question" ? qaQuestions : qaResponses;
  const sourceCaseId = input.sourceCaseId;
  const evidenceTarget = target.type === "question"
    ? { kind: "question" as const, questionId: target.id }
    : { kind: "response" as const, responseId: target.id };
  const state = input.visibility;

  async function authorize(context: LockedContext, replay: boolean) {
    const { tx, now } = context;
    const [post] = await readPost(tx, target);
    if (!post || post.deletedAt) throw new ApiError("NOT_FOUND");
    const { actor } = await requireAdminForLockedTarget(context, actorId, post.authorId);
    if (sourceCaseId !== undefined) {
      await requireQaMeasureCase(tx, {
        actor, caseId: sourceCaseId, target, now, replay,
      });
    }
    return post;
  }

  return commitMutation(database, {
    actorId, request, body: input,
    authorizeEntry: authorizeAdminEntry(actorId, "any"),
    async resolveUserIds(tx) {
      const [post] = await readPost(tx, target);
      return post ? [post.authorId] : [];
    },
    async targets() {
      return [
        { stage: "resource", table, idColumn: table.id, ids: [target.id] },
        { stage: "case", table: reportCases, idColumn: reportCases.id, ids: sourceCaseId ? [sourceCaseId] : [] },
      ];
    },
    async authorizeReplay(context, { resource }) {
      if (resource.type !== target.type || resource.id !== target.id) throw new ApiError("NOT_FOUND");
      await authorize(context, true);
    },
    async execute(context) {
      const { tx, now } = context;
      const post = await authorize(context, false);
      assertExpectedVersion(post.version, input.expectedVersion);
      const previous = post.forcedHiddenAt ? "hidden" : "public";
      if (previous === state) throw new ApiError("STATE_CONFLICT");

      // report_cases_one_active により、未終了案件は対象投稿ごとに最大1件。
      // 起点を指定した場合、証拠保全でも同じ案件のロックを使う。
      if (state === "hidden") await preserveEvidence(tx, { targets: [evidenceTarget] });
      const version = post.version + 1;
      await tx.update(table).set({ forcedHiddenAt: state === "hidden" ? now : null, updatedAt: now, version })
        .where(eq(table.id, target.id));

      if (sourceCaseId !== undefined) await recordCaseMeasure(tx, {
        caseId: sourceCaseId, actorId,
        measure: state === "hidden"
          ? { actionType: "qa_hidden", before: { publicationState: "public" }, after: { publicationState: "hidden" } }
          : { actionType: "qa_restored", before: { publicationState: "hidden" }, after: { publicationState: "public" } },
      });
      const auditLogId = await recordAuditLog(tx, {
        actorId, targetId: target.id, at: now,
        action: `${target.type}.${state === "hidden" ? "hidden" : "restored"}`,
        before: { publicationState: previous, version: post.version },
        after: { publicationState: state, version },
        publicReason: input.reason,
      });
      if (input.visibility === "hidden") {
        if (input.reason === null) throw new Error("Q&Aの非表示には本人向け理由が必要です。");
        const reference = target.type === "question" ? { questionId: target.id } : { responseId: target.id };
        await recordNotification(context, {
          recipientId: post.authorId, actorId, at: now,
          subject: { kind: "qa_hidden", ...reference, auditLogId, publicReason: input.reason },
        });
      }
      return { status: 200, resource: target, version, state };
    },
  });
}
