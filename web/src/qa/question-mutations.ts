import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { preserveEvidence } from "@/api/report-evidence";
import { handoffCasesOfDeletedTarget } from "@/api/report-handoff";
import { confirmed, expectedVersion, title, type MutationRequest } from "@/api/request";
import { ApiError } from "@/api/response";
import { authorizeActiveEntry, type AccessReader } from "@/auth/access";
import { requireOwned } from "@/auth/ownership";
import { qaQuestions } from "@/db/content-schema";
import { profiles, profileRevisions, qaCategories } from "@/db/schema";
import { longMarkdown } from "@/markdown/input";
import { questionCategoryCodes } from "./questions";

const fields = { title, bodyMarkdown: longMarkdown, categoryCode: z.enum(questionCategoryCodes) };
export const questionCreateSchema = z.strictObject(fields);
export const questionPatchSchema = questionCreateSchema.partial().extend({ expectedVersion }).refine(
  (patch) => patch.title !== undefined || patch.bodyMarkdown !== undefined || patch.categoryCode !== undefined,
  { message: "変更する項目を1つ以上指定してください。" },
);
/** 質問・回答等の本人削除（API-QA-06・11）。表示した版番号と、最終確認の `confirmed: true` が必要。 */
export const qaDeletionSchema = z.strictObject({ expectedVersion, confirmed });
/** 解決状態の変更（API-QA-12）。切り替えではなく、設定する状態を送る（API設計書 §7）。 */
export const questionResolutionSchema = z.strictObject({ expectedVersion, resolution: z.enum(["open", "resolved"]) });

type Database = Parameters<typeof commitMutation>[0];

async function categoryId(reader: AccessReader, code: string) {
  const [category] = await reader.select({ id: qaCategories.id }).from(qaCategories)
    .where(eq(qaCategories.code, code));
  if (!category) throw new ApiError("VALIDATION_FAILED", {
    fields: [{ path: "categoryCode", code: "invalid_category", message: "利用できるカテゴリーを選んでください。" }],
  });
  return category.id;
}

async function requireEditableQuestion(reader: AccessReader, actorId: string, questionId: string) {
  const [question] = await reader.select({
    authorId: qaQuestions.authorId, version: qaQuestions.version, forcedHiddenAt: qaQuestions.forcedHiddenAt,
  }).from(qaQuestions).where(and(eq(qaQuestions.id, questionId), isNull(qaQuestions.deletedAt)));
  return requireOwned(question, (row) => row.authorId, { userId: actorId });
}

/** 本人の質問。削除済みも含む。再送の確認で使い、他人の質問・存在しない質問は 404。 */
async function requireOwnQuestion(reader: AccessReader, actorId: string, questionId: string) {
  const [question] = await reader.select({ authorId: qaQuestions.authorId }).from(qaQuestions)
    .where(eq(qaQuestions.id, questionId));
  return requireOwned(question, (row) => row.authorId, { userId: actorId });
}

/** 投稿時点の公開表示名。投稿上の著者名（`author_label`）として保存する。 */
export async function currentDisplayName(reader: AccessReader, actorId: string): Promise<string> {
  const [profile] = await reader.select({ displayName: profileRevisions.displayName }).from(profiles)
    .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
    .where(eq(profiles.userId, actorId));
  if (!profile) throw new ApiError("NOT_FOUND");
  return profile.displayName;
}

function questionLocks(ids: readonly string[]) {
  return [{ stage: "resource" as const, table: qaQuestions, idColumn: qaQuestions.id, ids }];
}

export function createQuestion(database: Database, actorId: string, request: MutationRequest, body: z.infer<typeof questionCreateSchema>) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId, { profileWritable: true }),
    targets: async (_tx, replay) => questionLocks(replay?.type === "question" ? [replay.id] : []),
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "question") throw new ApiError("NOT_FOUND");
      await requireEditableQuestion(tx, actorId, resource.id);
    },
    async execute({ tx, now }) {
      const [question] = await tx.insert(qaQuestions).values({
        authorId: actorId, authorLabel: await currentDisplayName(tx, actorId), title: body.title, bodyMarkdown: body.bodyMarkdown,
        categoryId: await categoryId(tx, body.categoryCode), createdAt: now, updatedAt: now,
      }).returning({ id: qaQuestions.id, version: qaQuestions.version });
      return { status: 201, resource: { type: "question", id: question.id }, version: question.version, state: "public" };
    },
  });
}

export function updateQuestion(
  database: Database, actorId: string, request: MutationRequest, questionId: string, body: z.infer<typeof questionPatchSchema>,
) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId, { profileWritable: true }),
    targets: async () => questionLocks([questionId]),
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "question" || resource.id !== questionId) throw new ApiError("NOT_FOUND");
      await requireEditableQuestion(tx, actorId, questionId);
    },
    async execute({ tx, now }) {
      const question = await requireEditableQuestion(tx, actorId, questionId);
      assertExpectedVersion(question.version, body.expectedVersion);
      // 通報された公開中の質問なら、編集前の内容を未終了案件の証拠に残す（DB・ER設計書 §5、#47 ③）。
      await preserveEvidence(tx, { targets: [{ kind: "question", questionId }] });
      const version = question.version + 1;
      await tx.update(qaQuestions).set({
        title: body.title,
        bodyMarkdown: body.bodyMarkdown,
        categoryId: body.categoryCode === undefined ? undefined : await categoryId(tx, body.categoryCode),
        version, updatedAt: now,
      }).where(eq(qaQuestions.id, questionId));
      return { status: 200, resource: { type: "question", id: questionId }, version, state: question.forcedHiddenAt ? "hidden" : "public" };
    },
  });
}

/**
 * 質問の本人削除（API-QA-06、画面ID QA-02）。Issue #9 ⑤。
 *
 * - 本人の未削除の質問だけを論理削除する。プロフィール非表示中・強制非表示中も削除できる（共通認可条件表 §2）。
 * - 回答・コメント・返信は連鎖削除しない。残存する投稿は、それぞれの状態で表示・返信できる。
 * - 削除の前に、通報された公開中の内容を証拠として保全する（`preserveEvidence`、DB・ER設計書 §5）。そのあと、この質問の
 *   未終了案件のうち、アプリ管理者が担当する案件を引継ぎ待ちにする（`handoffCasesOfDeletedTarget`、権限マトリクス 4.1）。
 *   どちらも削除と同じトランザクションで確定する。
 * - 再送では削除をやり直さず、本人の質問であることを確かめて最初の結果を返す。
 */
export function deleteQuestion(
  database: Database, actorId: string, request: MutationRequest, questionId: string, body: z.infer<typeof qaDeletionSchema>,
) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId),
    targets: async () => questionLocks([questionId]),
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "question" || resource.id !== questionId) throw new ApiError("NOT_FOUND");
      await requireOwnQuestion(tx, actorId, questionId);
    },
    async execute({ tx, now, requireLockedUsers }) {
      const question = await requireEditableQuestion(tx, actorId, questionId);
      assertExpectedVersion(question.version, body.expectedVersion);
      const target = { kind: "question" as const, questionId };
      await preserveEvidence(tx, { targets: [target] });
      const version = question.version + 1;
      await tx.update(qaQuestions).set({ deletedAt: now, version, updatedAt: now }).where(eq(qaQuestions.id, questionId));
      await handoffCasesOfDeletedTarget({ tx, requireLockedUsers }, { target });
      return { status: 200, resource: { type: "question", id: questionId }, version, state: "deleted" };
    },
  });
}

/**
 * 質問の解決状態の変更（API-QA-12、画面ID QA-02）。Issue #9 ⑥。
 *
 * - 質問者本人・プロフィール公開中・未削除の質問だけ。管理者でも他人の質問は変更できない（QA-10、AUTH-08）。
 *   編集と同じく、強制非表示中の質問も本人は変更できる。
 * - 未解決・解決済みは何度でも変更でき、解決済みの質問にも回答できる（QA-04）。今と同じ状態の指定は 409 STATE_CONFLICT。
 * - 解決状態は通報証拠の項目（題名・本文・著者名）に含まれないため、証拠は保全しない。
 * - 結果の `state` は変更後の解決状態（API設計書 §13）。
 */
export function updateQuestionResolution(
  database: Database, actorId: string, request: MutationRequest, questionId: string,
  body: z.infer<typeof questionResolutionSchema>,
) {
  return commitMutation(database, {
    actorId, request, body,
    authorizeEntry: authorizeActiveEntry(actorId, { profileWritable: true }),
    targets: async () => questionLocks([questionId]),
    async authorizeReplay({ tx }, { resource }) {
      if (resource.type !== "question" || resource.id !== questionId) throw new ApiError("NOT_FOUND");
      await requireEditableQuestion(tx, actorId, questionId);
    },
    async execute({ tx, now }) {
      const question = await requireEditableQuestion(tx, actorId, questionId);
      assertExpectedVersion(question.version, body.expectedVersion);
      const [{ resolution }] = await tx.select({ resolution: qaQuestions.resolution }).from(qaQuestions)
        .where(eq(qaQuestions.id, questionId));
      if (resolution === body.resolution) throw new ApiError("STATE_CONFLICT");
      const version = question.version + 1;
      await tx.update(qaQuestions).set({ resolution: body.resolution, version, updatedAt: now })
        .where(eq(qaQuestions.id, questionId));
      return { status: 200, resource: { type: "question", id: questionId }, version, state: body.resolution };
    },
  });
}
