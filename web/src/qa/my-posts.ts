import { and, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import type { AccessReader, Viewer } from "@/auth/access";
import { hasAdminScope, scopeForTarget } from "@/auth/admin";
import { isOwner } from "@/auth/ownership";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { communityUsers } from "@/db/schema";
import { markdownExcerpt } from "@/markdown/excerpt";

/**
 * 自分のQ&A投稿の一覧（API-QA-13、画面ID GE-05）。Issue #9 ⑥。
 *
 * - 本人の質問・回答・コメント・返信を合わせて、作成日時の降順・IDの降順で返す。`kind` で種類を絞り込める（API設計書 §3）。
 * - 自分で削除した投稿は一覧に出さない。削除済みの質問の下に残る自分の回答等は表示し、QA-02 への導線を保つ
 *   （画面一覧設計書 GE-05、共通認可条件表 GE-05）。強制非表示中の自分の投稿も、本人は閲覧できるため表示する。
 * - 親の質問の題名は、質問の詳細（API-QA-04）で閲覧者に見せる場合だけ返す。削除済みの質問と、閲覧できない強制非表示の
 *   質問では null にし、題名・本文を復元しない（API設計書 §5 MyQaItem）。
 */

export const myQaKinds = ["question", "answer", "comment", "reply"] as const;
export type MyQaKind = (typeof myQaKinds)[number];

/** API設計書 §5 MyQaItem。 */
export type MyQaItem = {
  id: string;
  kind: MyQaKind;
  questionId: string;
  /** 親の質問（質問の場合は自分自身）の題名。削除済み・閲覧できない強制非表示の質問では null。 */
  questionTitle: string | null;
  questionState: "public" | "hidden" | "deleted";
  /** 本文の冒頭（Markdownの記号を除いた平文）。 */
  excerpt: string | null;
  createdAt: string;
  /** QA-02 の相対パス。回答等はスレッド内のアンカー付き。 */
  targetPath: string;
};

export const myQaFilters = { kind: z.enum(["all", ...myQaKinds]).default("all") };

export type MyQaQuery = ReturnType<typeof parseMyQaQuery>;

/** URLのクエリーを検証する。未定義の項目・値は 400 BAD_REQUEST。 */
export function parseMyQaQuery(url: URL) {
  return parseListQuery(url, myQaFilters);
}

const cursorPosition = z.tuple([z.string(), z.string()]);

/** 質問と回答等を、同じ列の投稿として1つにまとめる。 */
function postsOf(reader: AccessReader) {
  const questions = reader.select({
    id: qaQuestions.id,
    kind: sql<MyQaKind>`'question'::text`.as("kind"),
    questionId: sql<string>`${qaQuestions.id}`.as("question_id"),
    authorId: qaQuestions.authorId,
    bodyMarkdown: qaQuestions.bodyMarkdown,
    forcedHiddenAt: qaQuestions.forcedHiddenAt,
    createdAt: qaQuestions.createdAt,
    deletedAt: qaQuestions.deletedAt,
  }).from(qaQuestions);
  const responses = reader.select({
    id: qaResponses.id,
    kind: sql<MyQaKind>`${qaResponses.kind}`.as("kind"),
    questionId: sql<string>`${qaResponses.questionId}`.as("question_id"),
    authorId: qaResponses.authorId,
    bodyMarkdown: qaResponses.bodyMarkdown,
    forcedHiddenAt: qaResponses.forcedHiddenAt,
    createdAt: qaResponses.createdAt,
    deletedAt: qaResponses.deletedAt,
  }).from(qaResponses);
  return questions.unionAll(responses).as("posts");
}

export async function listMyQaPosts(reader: AccessReader, viewer: Viewer, query: MyQaQuery) {
  const { kind, limit, cursor } = query;
  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "me/qa-posts",
    filters: { kind },
    sort: "createdAt:desc,id:desc",
  }, cursorPosition);
  const last = codec.decode(cursor);
  const posts = postsOf(reader);

  return queryListPage({
    // 本人の、自分で削除していない投稿だけ。件数・カーソルにも同じ条件を適用する。
    authorized: and(eq(posts.authorId, viewer.userId), isNull(posts.deletedAt)) as SQL,
    filters: kind === "all" ? undefined : eq(posts.kind, kind),
    after: last ? sql`(${posts.createdAt}, ${posts.id}) < (${last[0]}::timestamptz, ${last[1]}::uuid)` : undefined,
    limit,
    rows: (where, take) => reader.select({
      id: posts.id,
      kind: posts.kind,
      questionId: posts.questionId,
      bodyMarkdown: posts.bodyMarkdown,
      createdAt: posts.createdAt,
      cursorAt: cursorTimestamp(posts.createdAt),
      questionTitle: qaQuestions.title,
      questionAuthorId: qaQuestions.authorId,
      questionHiddenAt: qaQuestions.forcedHiddenAt,
      questionDeletedAt: qaQuestions.deletedAt,
      questionAuthorSchoolManager: communityUsers.schoolManager,
      questionAuthorAppManager: communityUsers.appManager,
    }).from(posts)
      .innerJoin(qaQuestions, eq(qaQuestions.id, posts.questionId))
      .innerJoin(communityUsers, eq(communityUsers.userId, qaQuestions.authorId))
      .where(where).orderBy(desc(posts.createdAt), desc(posts.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(posts).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row): MyQaItem => {
      const questionState = row.questionDeletedAt ? "deleted" : row.questionHiddenAt ? "hidden" : "public";
      // 質問の詳細（loadQuestion）と同じ条件で、題名を見せられるかを判定する。
      const titleVisible = questionState === "public" || (questionState === "hidden" && (
        isOwner(viewer, row.questionAuthorId) || hasAdminScope(viewer, scopeForTarget({
          schoolManager: row.questionAuthorSchoolManager, appManager: row.questionAuthorAppManager,
        }))
      ));
      return {
        id: row.id,
        kind: row.kind,
        questionId: row.questionId,
        questionTitle: titleVisible ? row.questionTitle : null,
        questionState,
        excerpt: markdownExcerpt(row.bodyMarkdown),
        createdAt: row.createdAt.toISOString(),
        targetPath: row.kind === "question"
          ? `/questions/${row.questionId}`
          : `/questions/${row.questionId}#response-${row.id}`,
      };
    },
  });
}
