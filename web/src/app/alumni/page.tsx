import type { Metadata } from "next";
import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { parseAlumniQuery, searchAlumni, type PublicProfile } from "@/profile/public-profile";
import { AlumniResults } from "./alumni-results";
import { AlumniSearchForm } from "./alumni-search-form";
import { alumniFieldErrors, alumniFilterNames, type AlumniFieldErrors, type AlumniFilterValues } from "./field-errors";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "卒業生検索" };

/** 画面のクエリーから、検索条件（空欄は指定なし）とカーソルを取り出す。配列（同名の複数指定）は形式の誤りとして扱う。 */
function readParams(searchParams: ScreenSearchParams) {
  const values: AlumniFilterValues = {};
  const query = new URLSearchParams();
  let malformed = false;
  for (const name of [...alumniFilterNames, "cursor"] as const) {
    const raw = searchParams[name];
    if (Array.isArray(raw)) malformed = true;
    const value = typeof raw === "string" ? raw : "";
    if (name !== "cursor") values[name] = value;
    if (value.trim() !== "") query.set(name, value);
  }
  return { values, query, malformed };
}

type SearchResult =
  | { kind: "ok"; items: PublicProfile[]; page: PageInfo }
  /** 修正が必要な欄がある。案内は検索フォームに表示する。 */
  | { kind: "fields"; errors: AlumniFieldErrors }
  /** 特定の欄によらない誤り。 */
  | { kind: "invalid"; message: string; cursorExpired?: true };

/** GE-04 卒業生検索。掲載希望があり、プロフィール公開中の卒業生・卒業予定の在校生だけを表示する。 */
export default async function AlumniPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/alumni", resolved);
  const { values, query, malformed } = readParams(resolved);
  const errors = alumniFieldErrors(values);

  let result: SearchResult;
  if (malformed) {
    result = { kind: "invalid", message: "検索条件を確認してください。" };
  } else if (Object.keys(errors).length > 0) {
    result = { kind: "fields", errors };
  } else {
    try {
      // DBクライアントは描画時に読み込む（ビルド時にDB接続情報を必要としない）。
      const { db } = await import("@/db/client");
      const { data, page } = await searchAlumni(db, viewer, parseAlumniQuery(new URL(`http://app/alumni?${query}`)));
      result = { kind: "ok", items: data.items, page };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      result = error.code === "INVALID_CURSOR"
        ? { kind: "invalid", message: "検索結果の続きを表示できませんでした。最初のページから表示し直してください。", cursorExpired: true }
        : { kind: "invalid", message: "検索条件を確認してください。" };
    }
  }

  const nextQuery = new URLSearchParams(query);
  nextQuery.delete("cursor");
  const firstPage = `/alumni${nextQuery.size ? `?${nextQuery}` : ""}`;
  if (result.kind === "ok" && result.page.nextCursor) nextQuery.set("cursor", result.page.nextCursor);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>卒業生検索</h1>
          <p className={styles.lead}>卒業生検索への掲載を希望した、卒業生と卒業予定の在校生を探せます。</p>
        </header>

        {/* 適用中の条件が変わる画面内の遷移（共通ナビなど）では、未送信の入力を残さず入力欄を作り直す。 */}
        <AlumniSearchForm key={firstPage} values={values} errors={result.kind === "fields" ? result.errors : {}} />

        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            {result.cursorExpired ? <Link href={firstPage}>最初のページを表示する</Link> : null}
          </div>
        ) : null}
        {result.kind === "ok" ? (
          <AlumniResults
            items={result.items}
            page={result.page}
            continued={query.has("cursor")}
            firstPageHref={firstPage}
            nextPageHref={result.page.nextCursor ? `/alumni?${nextQuery}` : null}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
