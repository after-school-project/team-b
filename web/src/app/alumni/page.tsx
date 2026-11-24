import type { Metadata } from "next";
import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { EmptyState } from "@/components/feedback/StateMessage";
import { parseAlumniQuery, searchAlumni, type PublicProfile } from "@/profile/public-profile";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "卒業生検索" };

const filterNames = ["q", "department", "entryYear", "graduationYear"] as const;
type FilterName = (typeof filterNames)[number];
const baseRoleLabels: Record<PublicProfile["baseRole"], string> = { student: "在校生", alumni: "卒業生", staff: "学校職員" };

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

        <form className={styles.filters} action="/alumni" method="get" role="search" aria-label="卒業生の検索条件">
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
            <Link className={styles.textLink} href="/alumni">条件をクリア</Link>
          </div>
        </form>

        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            {result.cursorExpired ? <Link href={firstPage}>最初のページを表示する</Link> : null}
          </div>
        ) : (
          <section className={styles.results} aria-labelledby="alumni-results">
            <h2 id="alumni-results" className={styles.sectionTitle}>
              検索結果 <span className={styles.count}>{result.page.totalCount}件</span>
            </h2>
            {result.items.length === 0 ? (
              <EmptyState title="条件に合う卒業生・卒業予定者はいません。" headingLevel={3}
                description="キーワードや年度を変えて検索してください。" />
            ) : (
              <ul className={styles.list}>
                {result.items.map((profile) => (
                  <li key={profile.userId} className={styles.item}>
                    <p className={styles.badges}>
                      <span className={styles.badgeInfo}>{baseRoleLabels[profile.baseRole]}</span>
                      {profile.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}
                    </p>
                    <h3 className={styles.itemTitle}>
                      <Link href={`/users/${encodeURIComponent(profile.userId)}`}>{profile.fields.displayName}</Link>
                    </h3>
                    {profile.fields.optionalFields.occupation?.value ? (
                      <p className={styles.summary}>{profile.fields.optionalFields.occupation.value}</p>
                    ) : null}
                    <p className={styles.meta}>
                      {[profile.fields.department, profile.fields.graduationYear ? `${profile.fields.graduationYear}年度卒業` : null]
                        .filter(Boolean).join("・") || "学科・年度の登録なし"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {result.page.nextCursor ? (
              <p className={styles.pager}>
                <Link className={styles.secondaryLink} href={`/alumni?${nextQuery}`}>次の{result.page.limit}件を表示</Link>
              </p>
            ) : null}
          </section>
        )}
      </div>
    </AppShell>
  );
}
