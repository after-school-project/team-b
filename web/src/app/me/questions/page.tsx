import type { Metadata } from "next";
import Link from "next/link";
import { ApiError, type PageInfo } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { listMyQaPosts, myQaKinds, parseMyQaQuery, type MyQaItem, type MyQaKind } from "@/qa/my-posts";
import { MyPostsResults, myQaKindLabels } from "./my-posts-results";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "自分のQ&A" };

type Result =
  | { kind: "ok"; items: MyQaItem[]; page: PageInfo }
  | { kind: "invalid"; message: string };

const kindOptions = ["all", ...myQaKinds] as const;

function kindHref(kind: MyQaKind | "all"): string {
  return kind === "all" ? "/me/questions" : `/me/questions?${new URLSearchParams({ kind })}`;
}

/**
 * GE-05 自分のQ&A投稿一覧。本人の質問・回答・コメント・返信を新しい順に表示し、種類で絞り込める。
 * プロフィール非表示中も、本人の既存投稿を確認して QA-02 で削除できる。
 */
export default async function MyQuestionsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell } = await requireAppScreen("/me/questions", params);

  const query = new URLSearchParams();
  let malformed = false;
  for (const [name, value] of Object.entries(params)) {
    if (!["kind", "cursor"].includes(name) || typeof value !== "string") malformed = true;
    else if (value !== "") query.set(name, value);
  }
  const selected = kindOptions.find((option) => option === (query.get("kind") ?? "all"));

  let result: Result;
  if (malformed || !selected) {
    result = { kind: "invalid", message: "一覧の条件を確認してください。" };
  } else {
    try {
      const { data, page } = await readForScreen((db) =>
        listMyQaPosts(db, viewer, parseMyQaQuery(new URL(`http://app/me/qa-posts?${query}`))));
      result = { kind: "ok", items: data.items, page };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      result = {
        kind: "invalid",
        message: error.code === "INVALID_CURSOR"
          ? "一覧の続きを表示できませんでした。最初のページから表示し直してください。"
          : "一覧の条件を確認してください。",
      };
    }
  }

  const current = selected ?? "all";
  const firstPage = kindHref(current);
  const nextQuery = new URLSearchParams(current === "all" ? {} : { kind: current });
  if (result.kind === "ok" && result.page.nextCursor) nextQuery.set("cursor", result.page.nextCursor);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>自分のQ&A</h1>
          <p className={styles.lead}>自分の質問・回答・コメント・返信を確認できます。削除した投稿は表示されません。</p>
        </header>
        <nav aria-label="投稿の種類">
          <ul className={styles.kinds}>
            {kindOptions.map((option) => (
              <li key={option}>
                <Link className={styles.kind} href={kindHref(option)} aria-current={option === current ? "page" : undefined}>
                  {option === "all" ? "すべて" : myQaKindLabels[option]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            <Link href="/me/questions">一覧を開き直す</Link>
          </div>
        ) : (
          <MyPostsResults items={result.items} page={result.page} kind={current}
            continued={query.has("cursor")} firstPageHref={firstPage}
            nextPageHref={result.page.nextCursor ? `/me/questions?${nextQuery}` : null} />
        )}
      </div>
    </AppShell>
  );
}
