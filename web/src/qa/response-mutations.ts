import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { recordNotification, type NotificationSubject } from "@/api/notifications";
import { preserveEvidence } from "@/api/report-evidence";
import { handoffCasesOfDeletedTarget } from "@/api/report-handoff";
import { expectedVersion, uuid, type MutationRequest } from "@/api/request";
import { ApiError, type FieldError } from "@/api/response";
import { authorizeActiveEntry, type AccessReader } from "@/auth/access";
import { requireOwned } from "@/auth/ownership";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { longMarkdown } from "@/markdown/input";
import { currentDisplayName, type qaDeletionSchema } from "./question-mutations";
import type { ResponseKind } from "./responses";

/**
 * 回答・コメント・返信の作成・編集（API-QA-08・10、画面ID QA-02）。Issue #9 ④。
 *
 * - answer は親なし、reply は親の回答等が必須、comment の親は質問（親なし）か同じ質問内の回答等（API設計書 §7）。
 * - 親は現在も返信できる状態であることをロック後に確認する。削除済み・強制非表示の質問への回答・直接のコメントと、
 *   削除済み・強制非表示の回答等への直接の返信は 409 STATE_CONFLICT。質問が削除・非表示でも、残存する回答等への返信は
 *   その回答等の状態で判定する（共通認可条件表 §2）。
 * - 本文は、回答が10,000文字、コメント・返信が2,000文字以内の制限Markdown。
 * - 新しい回答は質問者、コメント・返信は直接の親の投稿者へ、同じトランザクションで通知する。自己通知は送らない
 *   （DB・ER設計書「通知の生成」）。
 * - 編集で変えられるのは本文だけ。投稿の種類・親・質問は変えられず、強制非表示の状態も解除しない。
 * - 編集の前に、公開中の内容を通報証拠として同じトランザクションで保全する（DB・ER設計書 §5、#47 ③）。
 */

const shortMarkdownLength = 2_000;

function fieldIssue(path: string, fieldError: Omit<FieldError, "path">) {
  return { code: "custom" as const, path: [path], params: { fieldError } };
}

const tooLongForShort = {
  code: "too_big", message: "コメント・返信は2,000文字以内で入力してください。",
} as const;

export const responseCreateSchema = z.strictObject({
  kind: z.enum(["answer", "comment", "reply"]),
  parentResponseId: uuid.nullable().optional(),
  bodyMarkdown: longMarkdown,
}).superRefine((value, context) => {
  if (value.kind === "answer" && value.parentResponseId != null) {
    context.addIssue(fieldIssue("parentResponseId", {
      code: "parent_not_allowed", message: "回答には返信先を指定できません。",
    }));
  }
  if (value.kind === "reply" && value.parentResponseId == null) {
    context.addIssue(fieldIssue("parentResponseId", {
      code: "parent_required", message: "返信先の投稿を指定してください。",
    }));
  }
  if (value.kind !== "answer" && [...value.bodyMarkdown].length > shortMarkdownLength) {
    context.addIssue(fieldIssue("bodyMarkdown", tooLongForShort));
  }
});

export const responsePatchSchema = z.strictObject({ expectedVersion, bodyMarkdown: longMarkdown });

type Database = Parameters<typeof commitMutation>[0];

const notificationKinds = {
  answer: "qa_answer_created",
  comment: "qa_comment_created",
  reply: "qa_reply_created",
} as const satisfies Record<ResponseKind, NotificationSubject["kind"]>;

function parentNotFound(): ApiError {
  return new ApiError("VALIDATION_FAILED", {
    fields: [{ path: "parentResponseId", code: "parent_not_found", message: "返信先の投稿が見つかりません。" }],
  });
}

/**
 * 新しい投稿の親と通知の宛先。親の回答等があればその投稿者、なければ質問者。
 * 返信できない状態の親は 409 STATE_CONFLICT、同じ質問内にない親は 422。
 */
async function resolveParent(reader: AccessReader, questionId: string, parentResponseId: string | null) {
  const [question] = await reader.select({
    authorId: qaQuestions.authorId, forcedHiddenAt: qaQuestions.forcedHiddenAt, deletedAt: qaQuestions.deletedAt,
  }).from(qaQuestions).where(eq(qaQuestions.id, questionId));
  if (!question) throw new ApiError("NOT_FOUND");
  if (parentResponseId === null) {
    if (question.deletedAt || question.forcedHiddenAt) throw new ApiError("STATE_CONFLICT");
    return { recipientId: question.authorId };
  }
  const [parent] = await reader.select({
    questionId: qaResponses.questionId, authorId: qaResponses.authorId,
    forcedHiddenAt: qaResponses.forcedHiddenAt, deletedAt: qaResponses.deletedAt,
  }).from(qaResponses).where(eq(qaResponses.id, parentResponseId));
  if (!parent || parent.questionId !== questionId) throw parentNotFound();
  if (parent.deletedAt || parent.forcedHiddenAt) throw new ApiError("STATE_CONFLICT");
  return { recipientId: parent.authorId };
}

/** 本人の未削除の回答等。他人の投稿・存在しない投稿・削除済みの投稿は 404。 */
async function requireEditableResponse(reader: AccessReader, actorId: string, responseId: string) {
  const [response] = await reader.select({
    authorId: qaResponses.authorId, questionId: qaResponses.questionId, kind: qaResponses.kind,
    version: qaResponses.version, forcedHiddenAt: qaResponses.forcedHiddenAt, deletedAt: qaResponses.deletedAt,
  }).from(qaResponses).where(eq(qaResponses.id, responseId));
  return requireOwned(response?.deletedAt ? undefined : response, (row) => row.authorId, { userId: actorId });
}

export function createResponse(
  database: Database, actorId: string, request: MutationRequest, questionId: string,
  body: z.infer<typeof responseCreateSchema>,
) {
  const parentResponseId = body.parentResponseId ?? null;
  return commitMutation(database, {
    actorId, request, body,
    // 通知の宛先をロック前に読む。ロック後に読み直した宛先が変わっていれば、requireLockedUsers がやり直す。
    async resolveUserIds(tx) {
      try {
        return [(await resolveParent(tx, questionId, parentResponseId)).recipientId];
      } catch (error) {
        if (error instanceof ApiError) return [];
        throw error;
      }
    },
    authorizeEntry: authorizeActiveEntry(actorId, { profileWritable: true }),
    targets: async (_tx, replay) => [
      { stage: "resource", table: qaQuestions, idColumn: qaQuestions.id, ids: [questionId] },
      {
        stage: "resource", table: qaResponses, idColumn: qaResponses.id,
        ids: [...(parentResponseId ? [parentResponseId] : []), ...(replay?.type === "response" ? [replay.id] : [])],
      },
    ],
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "response") throw new ApiError("NOT_FOUND");
      const response = await requireEditableResponse(tx, actorId, resource.id);
      if (response.questionId !== questionId) throw new ApiError("NOT_FOUND");
    },
    async execute({ tx, now, requireLockedUsers }) {
      const { recipientId } = await resolveParent(tx, questionId, parentResponseId);
      const [response] = await tx.insert(qaResponses).values({
        questionId, authorId: actorId, authorLabel: await currentDisplayName(tx, actorId),
        kind: body.kind, parentResponseId, bodyMarkdown: body.bodyMarkdown, createdAt: now, updatedAt: now,
      }).returning({ id: qaResponses.id, version: qaResponses.version });
      await recordNotification({ tx, requireLockedUsers }, {
        recipientId, actorId, subject: { kind: notificationKinds[body.kind], responseId: response.id }, at: now,
      });
      return { status: 201, resource: { type: "response", id: response.id }, version: response.version, state: "public" };
    },
  });
}

export function updateResponse(
  database: Database, actorId: string, request: MutationRequest, responseId: string,
  body: z.infer<typeof responsePatchSchema>,
) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId, { profileWritable: true }),
    targets: async () => [{ stage: "resource", table: qaResponses, idColumn: qaResponses.id, ids: [responseId] }],
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "response" || resource.id !== responseId) throw new ApiError("NOT_FOUND");
      await requireEditableResponse(tx, actorId, responseId);
    },
    async execute({ tx, now }) {
      const response = await requireEditableResponse(tx, actorId, responseId);
      assertExpectedVersion(response.version, body.expectedVersion);
      if (response.kind !== "answer" && [...body.bodyMarkdown].length > shortMarkdownLength) {
        throw new ApiError("VALIDATION_FAILED", { fields: [{ path: "bodyMarkdown", ...tooLongForShort }] });
      }
      // 通報された公開中の投稿なら、編集前の内容を未終了案件の証拠に残す。非表示・未通報の投稿では何もしない。
      await preserveEvidence(tx, { targets: [{ kind: "response", responseId }] });
      const version = response.version + 1;
      await tx.update(qaResponses).set({ bodyMarkdown: body.bodyMarkdown, version, updatedAt: now })
        .where(eq(qaResponses.id, responseId));
      return {
        status: 200, resource: { type: "response", id: responseId }, version,
        state: response.forcedHiddenAt ? "hidden" : "public",
      };
    },
  });
}

/** 本人の回答等。削除済みも含む。再送の確認で使い、他人の投稿・存在しない投稿は 404。 */
async function requireOwnResponse(reader: AccessReader, actorId: string, responseId: string) {
  const [response] = await reader.select({ authorId: qaResponses.authorId }).from(qaResponses)
    .where(eq(qaResponses.id, responseId));
  return requireOwned(response, (row) => row.authorId, { userId: actorId });
}

/**
 * 回答・コメント・返信の本人削除（API-QA-11、画面ID QA-02）。Issue #9 ⑤。
 * 対象の投稿だけを論理削除し、子の返信・コメントを連鎖削除しない。プロフィール非表示中・強制非表示中も削除できる。
 * 削除前の証拠保全と、アプリ管理者が担当する案件の引継ぎを同じトランザクションで行う（質問の削除と同じ）。
 * 再送では削除をやり直さず、本人の投稿であることを確かめて最初の結果を返す。
 */
export function deleteResponse(
  database: Database, actorId: string, request: MutationRequest, responseId: string,
  body: z.infer<typeof qaDeletionSchema>,
) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId),
    targets: async () => [{ stage: "resource", table: qaResponses, idColumn: qaResponses.id, ids: [responseId] }],
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "response" || resource.id !== responseId) throw new ApiError("NOT_FOUND");
      await requireOwnResponse(tx, actorId, responseId);
    },
    async execute({ tx, now, requireLockedUsers }) {
      const response = await requireEditableResponse(tx, actorId, responseId);
      assertExpectedVersion(response.version, body.expectedVersion);
      const target = { kind: "response" as const, responseId };
      await preserveEvidence(tx, { targets: [target] });
      const version = response.version + 1;
      await tx.update(qaResponses).set({ deletedAt: now, version, updatedAt: now }).where(eq(qaResponses.id, responseId));
      await handoffCasesOfDeletedTarget({ tx, requireLockedUsers }, { target });
      return { status: 200, resource: { type: "response", id: responseId }, version, state: "deleted" };
    },
  });
}
