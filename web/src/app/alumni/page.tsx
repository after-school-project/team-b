import type { Metadata } from "next";
import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { parseAlumniQuery, searchAlumni, type PublicProfile } from "@/profile/public-profile";
import { AlumniResults } from "./alumni-results";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "卒業生検索" };

const filterNames = ["q", "department", "entryYear", "graduationYear"] as const;
type FilterName = (typeof filterNames)[number];

/** 画面のクエリーから、検索条件（空欄は指定なし）とカーソルを取り出す。配列（同名の複数指定）は形式の誤りとして扱う。 */
function readParams(searchParams: ScreenSearchParams) {
  const values: Partial<Record<FilterName, string>> = {};
  const query = new URLSearchParams();
  let malformed = false;
  for (const name of [...filterNames, "cursor"] as const) {
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
  | { kind: "invalid"; message: string; cursorExpired?: true };

/** GE-04 卒業生検索。掲載希望があり、プロフィール公開中の卒業生・卒業予定の在校生だけを表示する。 */
export default async function AlumniPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/alumni", resolved);
  const { values, query, malformed } = readParams(resolved);

  let result: SearchResult;
  if (malformed) {
    result = { kind: "invalid", message: "検索条件を確認してください。" };
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
        : { kind: "invalid", message: "検索条件を確認してください。キーワードと学科は100文字以内、年度は4桁の数字で入力してください。" };
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
        <form key={firstPage} className={styles.filters} action="/alumni" method="get" role="search" aria-label="卒業生の検索条件">
          <div className={styles.field}>
            <label className={styles.label} htmlFor="alumni-q">キーワード</label>
            <input id="alumni-q" className={styles.input} name="q" defaultValue={values.q} maxLength={100}
              aria-describedby="alumni-q-help" />
            <p id="alumni-q-help" className={styles.help}>公開表示名・学科と、公開されている自己紹介・職種・関心分野から探します。</p>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="alumni-department">学科</label>
            <input id="alumni-department" className={styles.input} name="department" defaultValue={values.department}
              maxLength={100} />
          </div>
          <div className={styles.years}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="alumni-entry">入学年度</label>
              <input id="alumni-entry" className={styles.input} name="entryYear" defaultValue={values.entryYear}
                inputMode="numeric" pattern="[0-9]{4}" maxLength={4} aria-describedby="alumni-year-help" />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="alumni-graduation">卒業年度</label>
              <input id="alumni-graduation" className={styles.input} name="graduationYear" defaultValue={values.graduationYear}
                inputMode="numeric" pattern="[0-9]{4}" maxLength={4} aria-describedby="alumni-year-help" />
            </div>
          </div>
          <p id="alumni-year-help" className={styles.help}>年度は4桁の数字（例：2026）で入力します。</p>
          <div className={styles.actions}>
            <button type="submit" className={styles.primaryButton}>検索する</button>
            <button type="submit" form="alumni-clear" className={styles.textButton}>条件をクリア</button>
          </div>
        </form>
        {/* 条件のクリアは項目のない別のフォームで送信する。検索前（同じURL）でもページを読み直し、未送信の入力も消す。 */}
        <form id="alumni-clear" action="/alumni" method="get" hidden />

        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            {result.cursorExpired ? <Link href={firstPage}>最初のページを表示する</Link> : null}
          </div>
        ) : (
          <AlumniResults
            items={result.items}
            page={result.page}
            continued={query.has("cursor")}
            firstPageHref={firstPage}
            nextPageHref={result.page.nextCursor ? `/alumni?${nextQuery}` : null}
          />
        )}
      </div>
    </AppShell>
  );
}
