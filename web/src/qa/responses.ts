import { asc, count, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createCursorCodec, cursorTimestamp, parseListQuery, queryListPage } from "@/api/pagination";
import { ApiError } from "@/api/response";
import type { AccessReader, Viewer } from "@/auth/access";
import { canWriteContent } from "@/auth/access";
import { hasAdminScope, scopeForTarget } from "@/auth/admin";
import { noCapabilities, type CapabilitySet } from "@/auth/capabilities";
import { isOwner } from "@/auth/ownership";
import { qaQuestions, qaResponses } from "@/db/content-schema";
import { communityUsers } from "@/db/schema";
import type { PublicAuthor } from "./questions";

/**
 * 回答・コメント・返信の取得（API-QA-07・09、画面ID QA-02）。Issue #9 ③④。
 *
 * - 一覧は同じ質問内の回答等を作成日時・IDの昇順で返す。親子関係は `parentResponseId` で表し、画面で組み立てる（API設計書 §7）。
 * - 親子関係を保つため、削除済み・閲覧できない強制非表示の回答等も、本文・著者・版番号・日時のない状態案内として返す
 *   （API設計書 §5「存在するスレッドへの状態案内」）。強制非表示の内容は、本人と、その投稿を管理できる管理者だけに返す。
 * - 質問が削除・非表示でも、残存する回答等はそれぞれの状態で判定する（API設計書 §7、共通認可条件表 §2）。
 */

export type ResponseKind = (typeof qaResponses.$inferSelect)["kind"];

/** API設計書 §5 ResponseView。閲覧できない内容は null。 */
export type ResponseView = {
  id: string;
  questionId: string;
  parentResponseId: string | null;
  kind: ResponseKind;
  capabilities: CapabilitySet;
} & ({
  publicationState: "public" | "hidden";
  content: { bodyMarkdown: string };
  author: PublicAuthor;
  version: number;
  createdAt: string;
  updatedAt: string;
} | {
  publicationState: "hidden" | "deleted";
  content: null;
  author: null;
  version: null;
  createdAt: null;
  updatedAt: null;
});

const responseColumns = {
  id: qaResponses.id,
  questionId: qaResponses.questionId,
  parentResponseId: qaResponses.parentResponseId,
  kind: qaResponses.kind,
  bodyMarkdown: qaResponses.bodyMarkdown,
  authorId: qaResponses.authorId,
  authorLabel: qaResponses.authorLabel,
  authorSchoolManager: communityUsers.schoolManager,
  authorAppManager: communityUsers.appManager,
  forcedHiddenAt: qaResponses.forcedHiddenAt,
  deletedAt: qaResponses.deletedAt,
  version: qaResponses.version,
  createdAt: qaResponses.createdAt,
  updatedAt: qaResponses.updatedAt,
};

function selectResponses(reader: AccessReader) {
  return reader.select(responseColumns).from(qaResponses)
    .innerJoin(communityUsers, eq(communityUsers.userId, qaResponses.authorId));
}

type ResponseRow = Awaited<ReturnType<typeof selectResponses>>[number];

/** 閲覧者に応じて ResponseView へ投影する。返信できるのは、公開中で未削除の投稿だけ。 */
function toResponseView(viewer: Viewer, row: ResponseRow): ResponseView {
  const base = { id: row.id, questionId: row.questionId, parentResponseId: row.parentResponseId, kind: row.kind };
  const publicationState = row.deletedAt ? "deleted" : row.forcedHiddenAt ? "hidden" : "public";
  const own = isOwner(viewer, row.authorId);
  const manageable = hasAdminScope(viewer, scopeForTarget({
    schoolManager: row.authorSchoolManager, appManager: row.authorAppManager,
  }));
  if (publicationState === "deleted" || (publicationState === "hidden" && !own && !manageable)) {
    return {
      ...base, publicationState, content: null, author: null, version: null, createdAt: null, updatedAt: null,
      capabilities: { ...noCapabilities },
    };
  }
  const writable = canWriteContent(viewer);
  return {
    ...base,
    publicationState,
    content: { bodyMarkdown: row.bodyMarkdown },
    author: { userId: row.authorId, displayName: row.authorLabel },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    capabilities: {
      ...noCapabilities,
      canEdit: own && writable,
      canDelete: own,
      canRespond: writable && publicationState === "public",
      canHide: manageable && publicationState === "public",
      canRestore: manageable && publicationState === "hidden",
    },
  };
}

export type ResponseQuery = ReturnType<typeof parseResponseQuery>;

/** URLのクエリーを検証する。絞り込み条件はなく、limit・cursor だけを受け付ける。 */
export function parseResponseQuery(url: URL) {
  return parseListQuery(url, {});
}

const cursorPosition = z.tuple([z.string(), z.string()]);

/**
 * 質問の回答・コメント・返信の一覧（API-QA-07）。作成日時の昇順・IDの昇順。存在しない質問は 404。
 * 親は子より先に作られるため、昇順で読み進めると親が先のページに現れる。カーソルは閲覧者・質問・並び順にひも付けて署名する。
 */
export async function listResponses(reader: AccessReader, viewer: Viewer, questionId: string, query: ResponseQuery) {
  const [question] = await reader.select({ id: qaQuestions.id }).from(qaQuestions).where(eq(qaQuestions.id, questionId));
  if (!question) throw new ApiError("NOT_FOUND");

  const codec = createCursorCodec({
    actorId: viewer.userId,
    list: "question-responses",
    filters: { questionId },
    sort: "createdAt:asc,id:asc",
  }, cursorPosition);
  const last = codec.decode(query.cursor);
  const authorized: SQL = eq(qaResponses.questionId, questionId);

  return queryListPage({
    authorized,
    after: last
      ? sql`(${qaResponses.createdAt}, ${qaResponses.id}) > (${last[0]}::timestamptz, ${last[1]}::uuid)`
      : undefined,
    limit: query.limit,
    rows: (where, take) => reader.select({ ...responseColumns, cursorAt: cursorTimestamp(qaResponses.createdAt) })
      .from(qaResponses).innerJoin(communityUsers, eq(communityUsers.userId, qaResponses.authorId))
      .where(where).orderBy(asc(qaResponses.createdAt), asc(qaResponses.id)).limit(take),
    count: async (where) => {
      const [{ total }] = await reader.select({ total: count() }).from(qaResponses).where(where);
      return total;
    },
    cursorFor: (row) => codec.encode([row.cursorAt, row.id]),
    toItem: (row) => toResponseView(viewer, row),
  });
}

/** 回答・コメント・返信の1件（API-QA-09）。存在しない投稿は 404。削除済み・閲覧できない強制非表示の投稿は状態だけを返す。 */
export async function loadResponse(reader: AccessReader, viewer: Viewer, responseId: string): Promise<ResponseView> {
  const [row] = await selectResponses(reader).where(eq(qaResponses.id, responseId));
  if (!row) throw new ApiError("NOT_FOUND");
  return toResponseView(viewer, row);
}
