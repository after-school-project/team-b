import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { commitMutation } from "@/api/mutation";
import { lockedCaseTime, preserveEvidence, type EvidenceTarget } from "@/api/report-evidence";
import { confirmed, optionalProfileText, requiredReason, userId, uuid, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import { loadAccessState, requireActive, type AccessReader } from "@/auth/access";
import { visibleQuestion, visibleResponse } from "@/auth/visibility";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { reportCases, reports, reportTargets } from "@/db/moderation-schema";
import { communityUsers } from "@/db/schema";
import { eligibleManager } from "./case-access";
import { reportDetailMaxLength, reportReasons } from "./labels";
import { findReportableUser } from "./target-access";

export const reportInputSchema = z.strictObject({
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("question"), id: uuid }),
    z.strictObject({ type: z.literal("response"), id: uuid }),
    z.strictObject({ type: z.literal("profile"), id: userId }),
    z.strictObject({ type: z.literal("account"), id: userId }),
  ]),
  reason: z.enum(reportReasons),
  detail: optionalProfileText(reportDetailMaxLength).nullish().transform((value) => value?.trim() || null),
  confirmed,
}).refine(({ reason, detail }) => reason !== "other" || requiredReason.safeParse(detail).success, {
  path: ["detail"], params: { fieldError: { code: "required", message: "その他を選ぶ場合は詳細を入力してください。" } },
});

type Input = z.output<typeof reportInputSchema>;
type Context = Parameters<Parameters<typeof commitMutation>[1]["execute"]>[0];

export async function receiveReport(
  database: Parameters<typeof commitMutation>[0], actorId: string, input: Input, request: MutationRequest,
) {
  const { type, id } = input.target;
  const postTable = type === "question" ? qaQuestions : type === "response" ? qaResponses : null;
  const target: EvidenceTarget = type === "question" ? { kind: type, questionId: id }
    : type === "response" ? { kind: type, responseId: id } : { kind: type, userId: id };
  const targetCondition = type === "question" ? eq(reportTargets.questionId, id)
    : type === "response" ? eq(reportTargets.responseId, id)
      : and(eq(reportTargets.kind, type), eq(reportTargets.subjectUserId, id));

  async function findSchoolAssignee(reader: AccessReader, subject?: string) {
    const [candidate] = await reader.select({ id: communityUsers.userId }).from(communityUsers)
      .where(and(eligibleManager(true), ne(communityUsers.userId, actorId), subject ? ne(communityUsers.userId, subject) : undefined))
      .orderBy(communityUsers.userId).limit(1);
    return candidate;
  }

  async function subjectId(reader: AccessReader, publiclyVisible: boolean) {
    if (!postTable) return id;
    const [post] = await reader.select({ authorId: postTable.authorId }).from(postTable).where(and(
      eq(postTable.id, id), publiclyVisible ? (type === "question" ? visibleQuestion() : visibleResponse()) : undefined,
    ));
    return post?.authorId;
  }

  async function authorize({ tx, requireLockedUsers }: Context) {
    const subject = await subjectId(tx, true);
    if (!subject || actorId === subject) throw new ApiError("NOT_FOUND");
    requireLockedUsers(subject);
    const user = await findReportableUser(tx, actorId, subject, type === "profile");
    if (!user) throw new ApiError("NOT_FOUND");
    return { ...user, subject };
  }

  const result = await commitMutation(database, {
    actorId, request, body: input,
    async authorizeEntry(tx) { requireActive(await loadAccessState(tx, actorId)); },
    async resolveUserIds(tx) {
      const subject = await subjectId(tx, false);
      const candidate = await findSchoolAssignee(tx, subject);
      return [subject, candidate?.id].filter((user): user is string => user !== undefined);
    },
    async targets() {
      return postTable ? [{ stage: "resource", table: postTable, idColumn: postTable.id, ids: [id] }] : [];
    },
    async authorizeReplay(context) { await authorize(context); },
    async execute(context) {
      const { tx, now, requireLockedUsers } = context;
      const user = await authorize(context);
      const reference = target.kind === "question" ? { questionId: target.questionId }
        : target.kind === "response" ? { responseId: target.responseId } : { subjectUserId: target.userId };
      // 対象者行と投稿行のロックが、異なる通報者からの受付と対象の更新を直列化する。
      await tx.insert(reportTargets).values({ kind: type, ...reference }).onConflictDoNothing();
      const [registered] = await tx.select({ id: reportTargets.id }).from(reportTargets).where(targetCondition);
      const [active] = await tx.select({ id: reportCases.id }).from(reportCases).where(and(
        eq(reportCases.targetId, registered.id), ne(reportCases.status, "closed"),
      )).for("update");
      let caseId = active?.id;
      if (caseId) {
        await tx.update(reportCases).set({ version: sql`${reportCases.version} + 1`, updatedAt: await lockedCaseTime(tx) })
          .where(eq(reportCases.id, caseId));
      } else {
        const assignee = await findSchoolAssignee(tx, user.subject);
        // 候補が変わったら、利用者行のロック順を保つため共通処理で受付をやり直す。
        if (assignee) requireLockedUsers(assignee.id);
        const [created] = await tx.insert(reportCases).values({
          targetId: registered.id, assigneeId: assignee?.id, schoolOnly: user.appManager || !assignee,
          handoffPending: !assignee, createdAt: now, updatedAt: now,
        }).returning({ id: reportCases.id });
        caseId = created.id;
      }
      const [report] = await tx.insert(reports).values({
        caseId, reporterId: actorId, reasonCode: input.reason, detail: input.detail, createdAt: now,
      }).returning({ id: reports.id });
      const evidence = await preserveEvidence(tx, { targets: [target] });
      if (evidence.length !== 1) throw new Error("受付時の通報証拠を保全できませんでした。");
      return { status: 201, resource: { type: "report", id: report.id }, version: null, state: "received" };
    },
  });
  return { status: result.status, replayed: result.replayed, data: { received: true, receivedAt: result.data.committedAt } };
}
