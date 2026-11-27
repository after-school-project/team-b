import type { Metadata } from "next";
import Link from "next/link";
import { ApiError, type PageInfo } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { parsePublicNoticeQuery, publicNoticeFilters, searchNotices, type NoticeListItem } from "@/notices/notices";
import { NoticeResults, NoticeSearchForm, NoticeSectionNav } from "./components";
import styles from "./notices.module.css";

export const metadata: Metadata = { title: "お知らせ" };

type SearchResult =
  | { kind: "ok"; items: NoticeListItem[]; page: PageInfo }
  | { kind: "invalid"; message: string; cursorExpired?: true }
  | { kind: "keyword"; message: string };

export default async function NoticesPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/notices", resolved);
  const rawQ = resolved.q;
  const rawCursor = resolved.cursor;
  const malformed = Array.isArray(rawQ) || Array.isArray(rawCursor) ||
    Object.keys(resolved).some((key) => key !== "q" && key !== "cursor");
  const q = typeof rawQ === "string" ? rawQ : "";
  const cursor = typeof rawCursor === "string" ? rawCursor : "";
  const query = new URLSearchParams();
  if (q.trim()) query.set("q", q);
  if (cursor.trim()) query.set("cursor", cursor);
  const firstPageHref = `/notices${q.trim() ? `?q=${encodeURIComponent(q)}` : ""}`;
  let result: SearchResult;

  if (malformed) {
    result = { kind: "invalid", message: "検索条件を確認してください。" };
  } else if (q.trim() && !publicNoticeFilters.q.unwrap().safeParse(q).success) {
    result = { kind: "keyword", message: "キーワードは前後空白を除いて1〜100文字で入力してください。" };
  } else {
    try {
      const { data, page } = await readForScreen((db) =>
        searchNotices(db, viewer, parsePublicNoticeQuery(new URL(`http://app/notices?${query}`))));
      result = { kind: "ok", items: data.items, page };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      result = error.code === "INVALID_CURSOR"
        ? { kind: "invalid", message: "お知らせの続きを表示できませんでした。最初のページから表示し直してください。", cursorExpired: true }
        : { kind: "invalid", message: "検索条件を確認してください。" };
    }
  }

  const nextQuery = new URLSearchParams(query);
  if (result.kind === "ok" && result.page.nextCursor) nextQuery.set("cursor", result.page.nextCursor);
  const canCreate = viewer.profileState === "public" && viewer.baseRole !== "student";
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <NoticeSectionNav current="public" />
        <header className={styles.pageHeading}>
          <h1 className={styles.title}>お知らせ</h1>
          {canCreate ? <Link className={styles.primaryButton} href="/notices/new">お知らせを作成</Link> : null}
        </header>
        {shell.canAccessAdmin ? <Link href="/admin/notices">お知らせの審査・公開管理</Link> : null}
        <NoticeSearchForm key={firstPageHref} q={q}
          error={result.kind === "keyword" ? result.message : undefined} />
        {result.kind === "invalid" ? (
          <div className={styles.formError} role="alert">
            <p>{result.message}</p>
            {result.cursorExpired ? <Link href={firstPageHref}>最初のページを表示する</Link> : null}
          </div>
        ) : null}
        {result.kind === "ok" ? (
          <NoticeResults items={result.items} page={result.page} filtered={Boolean(q.trim())}
            continued={Boolean(cursor)} firstPageHref={firstPageHref} search={query.toString()}
            nextPageHref={result.page.nextCursor ? `/notices?${nextQuery}` : null} />
        ) : null}
      </div>
    </AppShell>
  );
}
