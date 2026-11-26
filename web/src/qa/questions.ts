import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { containing, searchText } from "@/api/list-filters";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { canWriteContent } from "@/auth/access";
import { hasAdminScope, scopeForTarget } from "@/auth/admin";
import { noCapabilities, type CapabilitySet } from "@/auth/capabilities";
import { isOwner } from "@/auth/ownership";
import { visibleQuestion, visibleResponse } from "@/auth/visibility";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { communityUsers, qaCategories } from "@/db/schema";

/**
 * Q&Aのカテゴリー・質問の一覧・検索・詳細（API-QA-01・02・04、画面ID QA-01・QA-02）。Issue #9 ①③。
 *
 * - 一覧・検索・件数・カーソルの対象は、公開中（強制非表示でない）・未削除の質問だけ（`visibleQuestion`）。
 * - 詳細では、削除済み・閲覧できない強制非表示の質問を、本文・著者・版番号・日時のない状態案内として返す。
 *   強制非表示の質問の内容は、本人と、その質問を管理できる管理者だけに返す（API設計書 §5）。
 */

/** カテゴリーのコード。API設計書 §7 の値と順序。 */
export const questionCategoryCodes = ["career", "learning", "projects", "chat"] as const;

/** API設計書 §5 Category。 */
export type Category = { code: string; name: string };

/** API設計書 §5 PublicAuthor。投稿上の公開著者名。 */
export type PublicAuthor = { userId: string; displayName: string };

type Resolution = (typeof qaQuestions.$inferSelect)["resolution"];

/** API設計書 §5 QuestionListItem。 */
export type QuestionListItem = {
  id: string;
  title: string;
  category: Category;
  author: PublicAuthor;
  resolution: Resolution;
  /** 一般の閲覧者に表示できる回答・コメント・返信の件数。 */
  responseCount: number;
  createdAt: string;
  updatedAt: string;
};

/** API設計書 §5 QuestionView。閲覧できない内容は null。 */
export type QuestionView = {
  id: string;
  capabilities: CapabilitySet;
} & ({
  publicationState: "public" | "hidden";
  content: { title: string; bodyMarkdown: string; category: Category };
  author: PublicAuthor;
  resolution: Resolution;
  version: number;
  createdAt: string;
  updatedAt: string;
} | {
  publicationState: "hidden" | "deleted";
  content: null;
  author: null;
  resolution: null;
  version: null;
  createdAt: null;
  updatedAt: null;
});

/** Q&Aのカテゴリー（API-QA-01）。設計書の順に返す。 */
export async function listQuestionCategories(reader: AccessReader): Promise<Category[]> {
  const rows = await reader.select({ code: qaCategories.code, name: qaCategories.name }).from(qaCategories);
  return questionCategoryCodes.flatMap((code) => rows.filter((row) => row.code === code));
}

/** Q&A一覧のクエリー（API設計書 §3）。q は前後空白を除いた1〜100文字。 */
export const questionFilters = {
  q: searchText.optional(),
  category: z.enum(questionCategoryCodes).optional(),
  resolution: z.enum(["all", "open", "resolved"]).default("all"),
};

export type QuestionQuery = ReturnType<typeof parseQuestionQuery>;

/** URLのクエリーを検証する。未定義の項目・値は 400 BAD_REQUEST。 */
export function parseQuestionQuery(url: URL) {
  return parseListQuery(url, questionFilters);
}

const cursorPosition = z.tuple([z.string(), z.string()]);

/**
 * Q&A一覧・検索（API-QA-02）。作成日時の降順・IDの降順。キーワードは質問のタイトルと本文に部分一致させる。
 * カーソルは閲覧者・検索条件・並び順にひも付けて署名する。
 */
export async function searchQuestions(reader: AccessReader, viewer: Viewer, query: QuestionQuery) {
  const { q, category, resolution, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "questions",
    filters: { q, category, resolution },
    sort: "createdAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const pattern = q === undefined ? undefined : containing(q);
  const filters = [
    pattern === undefined ? undefined : or(ilike(qaQuestions.title, pattern), ilike(qaQuestions.bodyMarkdown, pattern)),
    category === undefined ? undefined : eq(qaCategories.code, category),
    resolution === "all" ? undefined : eq(qaQuestions.resolution, resolution),
  ].filter((condition): condition is SQL => condition !== undefined);
  const responseCount = reader.select({ total: sql`count(*)::int` }).from(qaResponses)
    .where(and(eq(qaResponses.questionId, qaQuestions.id), visibleResponse()));

  return queryListPage({
    authorized: visibleQuestion(),
    filters: filters.length ? and(...filters) : undefined,
    after: last
      ? sql`(${qaQuestions.createdAt}, ${qaQuestions.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: qaQuestions.id,
      title: qaQuestions.title,
      categoryCode: qaCategories.code,
      categoryName: qaCategories.name,
      authorId: qaQuestions.authorId,
      authorLabel: qaQuestions.authorLabel,
      resolution: qaQuestions.resolution,
      responseCount: sql<number>`(${responseCount})`,
      createdAt: qaQuestions.createdAt,
      updatedAt: qaQuestions.updatedAt,
      cursorAt: cursorTimestamp(qaQuestions.createdAt),
    }).from(qaQuestions).innerJoin(qaCategories, eq(qaCategories.id, qaQuestions.categoryId))
      .where(where).orderBy(desc(qaQuestions.createdAt), desc(qaQuestions.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(qaQuestions)
        .innerJoin(qaCategories, eq(qaCategories.id, qaQuestions.categoryId)).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): QuestionListItem => ({
      id: row.id,
      title: row.title,
      category: { code: row.categoryCode, name: row.categoryName },
      author: { userId: row.authorId, displayName: row.authorLabel },
      resolution: row.resolution,
      responseCount: row.responseCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  });
}

/**
 * 質問の詳細（API-QA-04）。存在しない質問は 404。削除済み・閲覧できない強制非表示の質問は状態だけを返す。
 * `capabilities` は操作の入口を出せるかを表し、APIのある操作だけを true にする。操作の受付は、各操作のAPIで再認可する。
 */
export async function loadQuestion(reader: AccessReader, viewer: Viewer, questionId: string): Promise<QuestionView> {
  const [row] = await reader.select({
    id: qaQuestions.id,
    title: qaQuestions.title,
    bodyMarkdown: qaQuestions.bodyMarkdown,
    categoryCode: qaCategories.code,
    categoryName: qaCategories.name,
    authorId: qaQuestions.authorId,
    authorLabel: qaQuestions.authorLabel,
    authorSchoolManager: communityUsers.schoolManager,
    authorAppManager: communityUsers.appManager,
    resolution: qaQuestions.resolution,
    forcedHiddenAt: qaQuestions.forcedHiddenAt,
    deletedAt: qaQuestions.deletedAt,
    version: qaQuestions.version,
    createdAt: qaQuestions.createdAt,
    updatedAt: qaQuestions.updatedAt,
  }).from(qaQuestions)
    .innerJoin(qaCategories, eq(qaCategories.id, qaQuestions.categoryId))
    .innerJoin(communityUsers, eq(communityUsers.userId, qaQuestions.authorId))
    .where(eq(qaQuestions.id, questionId));
  if (!row) throw new ApiError("NOT_FOUND");

  const publicationState = row.deletedAt ? "deleted" : row.forcedHiddenAt ? "hidden" : "public";
  const own = isOwner(viewer, row.authorId);
  const manageable = hasAdminScope(viewer, scopeForTarget({
    schoolManager: row.authorSchoolManager, appManager: row.authorAppManager,
  }));
  if (publicationState === "deleted" || (publicationState === "hidden" && !own && !manageable)) {
    return {
      id: row.id, publicationState, content: null, author: null, resolution: null, version: null,
      createdAt: null, updatedAt: null, capabilities: { ...noCapabilities },
    };
  }

  return {
    id: row.id,
    publicationState,
    content: {
      title: row.title,
      bodyMarkdown: row.bodyMarkdown,
      category: { code: row.categoryCode, name: row.categoryName },
    },
    author: { userId: row.authorId, displayName: row.authorLabel },
    resolution: row.resolution,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    capabilities: { ...noCapabilities, canEdit: own && canWriteContent(viewer) },
  };
}
