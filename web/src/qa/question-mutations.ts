import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertExpectedVersion, commitMutation } from "@/api/mutation";
import { expectedVersion, title, type MutationRequest } from "@/api/request";
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
      const [profile] = await tx.select({ displayName: profileRevisions.displayName }).from(profiles)
        .innerJoin(profileRevisions, eq(profileRevisions.id, profiles.currentRevisionId))
        .where(eq(profiles.userId, actorId));
      if (!profile) throw new ApiError("NOT_FOUND");
      const [question] = await tx.insert(qaQuestions).values({
        authorId: actorId, authorLabel: profile.displayName, title: body.title, bodyMarkdown: body.bodyMarkdown,
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
