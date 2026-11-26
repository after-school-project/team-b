import type { Metadata } from "next";
import Link from "next/link";
import { ApiError, type PageInfo } from "@/api/response";
import { canWriteContent } from "@/auth/access";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { listQuestionCategories, parseQuestionQuery, searchQuestions, type QuestionListItem } from "@/qa/questions";
import { hasQuestionFilter, keywordError, readQuestionParams } from "./question-filters";
import { QuestionResults } from "./question-results";
import { QuestionSearchForm } from "./question-search-form";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Q&A" };

type SearchResult =
  | { kind: "ok"; items: QuestionListItem[]; page: PageInfo }
  /** キーワードの修正が必要。案内は検索フォームに表示する。 */
  | { kind: "keyword"; error: string }
  /** 特定の欄によらない誤り。 */
  | { kind: "invalid"; message: string; cursorExpired?: true };

/** QA-01 Q&A一覧・検索。公開中・未削除の質問だけを表示する。 */
export default async function QuestionsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/questions", resolved);
  const { values, query, malformed } = readQuestionParams(resolved);
  const categories = await readForScreen((db) => listQuestionCategories(db));
  const invalidKeyword = keywordError(values.q);

  let result: SearchResult;
  if (malformed) {
    result = { kind: "invalid", message: "検索条件を確認してください。" };
  } else if (invalidKeyword) {
    result = { kind: "keyword", error: invalidKeyword };
  } else {
    try {
      const { data, page } = await readForScreen(async (db) =>
        searchQuestions(db, viewer, parseQuestionQuery(new URL(`http://app/questions?${query}`))));
      result = { kind: "ok", items: data.items, page };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      result = error.code === "INVALID_CURSOR"
        ? { kind: "invalid", message: "質問の続きを表示できませんでした。最初のページから表示し直してください。", cursorExpired: true }
        : { kind: "invalid", message: "検索条件を確認してください。" };
    }
  }

  const nextQuery = new URLSearchParams(query);
  nextQuery.delete("cursor");
  const firstPage = `/questions${nextQuery.size ? `?${nextQuery}` : ""}`;
  if (result.kind === "ok" && result.page.nextCursor) nextQuery.set("cursor", result.page.nextCursor);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Q&A</h1>
          <p className={styles.lead}>在校生・卒業生・学校職員の質問を探せます。</p>
          {canWriteContent(viewer) ? <Link className={styles.formLink}
            href={query.size ? `/questions/new?${new URLSearchParams({ from: `/questions?${query}` })}` : "/questions/new"}>
            質問を投稿
          </Link> : null}
        </header>

        {/* 適用中の条件が変わる画面内の遷移（共通ナビなど）では、未送信の入力を残さず入力欄を作り直す。 */}
        <QuestionSearchForm key={firstPage} categories={categories} values={values}
          keywordError={result.kind === "keyword" ? result.error : undefined} />

        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            {result.cursorExpired ? <Link href={firstPage}>最初のページを表示する</Link> : null}
          </div>
        ) : null}
        {result.kind === "ok" ? (
          <QuestionResults
            items={result.items}
            page={result.page}
            filtered={hasQuestionFilter(values)}
            continued={query.has("cursor")}
            firstPageHref={firstPage}
            nextPageHref={result.page.nextCursor ? `/questions?${nextQuery}` : null}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
