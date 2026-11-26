import type { Metadata } from "next";
import Link from "next/link";
import { ApiError, type PageInfo } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { EmptyState } from "@/components/feedback/StateMessage";
import { readForScreen } from "@/db/screen-read";
import { listNotifications, parseNotificationQuery, type NotificationView } from "@/notifications/notifications";
import { notificationStates, readNotificationParams } from "./notification-filters";
import { NotificationList } from "./notification-list";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "通知" };

type ListResult =
  | { kind: "ok"; items: NotificationView[]; page: PageInfo }
  | { kind: "invalid"; message: string; cursorExpired?: true };

const headingId = "notification-results";

/**
 * GE-06 通知一覧。受信者本人の通知を新しい順に表示し、未読だけに絞り込める。
 * 一覧を開いただけでは既読にしない。既読にするのは「既読にする」の操作だけ（API-NT-03）。
 * 停止中の利用者は、共通の入口（`requireAppScreen`）で停止案内へ送り、通知を読まない。
 */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/notifications", resolved);
  const { state, query, malformed } = readNotificationParams(resolved);

  let result: ListResult;
  if (malformed) {
    result = { kind: "invalid", message: "表示する通知の条件を確認してください。" };
  } else {
    try {
      const { data, page } = await readForScreen(async (db) =>
        listNotifications(db, viewer, parseNotificationQuery(new URL(`http://app/notifications?${query}`))));
      result = { kind: "ok", items: data.items, page };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      result = error.code === "INVALID_CURSOR"
        ? { kind: "invalid", message: "通知の続きを表示できませんでした。最初のページから表示し直してください。", cursorExpired: true }
        : { kind: "invalid", message: "表示する通知の条件を確認してください。" };
    }
  }

  const current = notificationStates.find((option) => option.value === state)!;
  const firstPage = current.href;
  const continued = query.has("cursor");
  const nextQuery = new URLSearchParams(query);
  if (result.kind === "ok" && result.page.nextCursor) nextQuery.set("cursor", result.page.nextCursor);
  const nextPage = result.kind === "ok" && result.page.nextCursor ? `/notifications?${nextQuery}` : null;

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>通知</h1>
          <p className={styles.lead}>あなた宛ての通知を新しい順に表示します。一覧を開いただけでは既読になりません。</p>
        </header>

        <nav aria-label="表示する通知">
          <ul className={styles.filters}>
            {notificationStates.map((option) => (
              <li key={option.value}>
                <Link className={styles.filterLink} href={option.href}
                  aria-current={!malformed && option.value === state ? "page" : undefined}>
                  {option.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {result.kind === "invalid" ? (
          <div className={styles.error} role="alert">
            <p>{result.message}</p>
            <Link href={result.cursorExpired ? firstPage : "/notifications"}>最初のページを表示する</Link>
          </div>
        ) : (
          <section className={styles.results} aria-labelledby={headingId}>
            <h2 id={headingId} className={styles.sectionTitle} tabIndex={-1}>
              {state === "unread" ? "未読の通知" : "通知"} <span className={styles.count}>{result.page.totalCount}件</span>
            </h2>
            {result.items.length === 0 && continued && result.page.totalCount > 0 ? (
              <div className={styles.notice} role="status">
                <p>一覧が変わったため、この続きに表示できる通知はありません。最初のページから確認してください。</p>
              </div>
            ) : result.items.length === 0 ? (
              <EmptyState headingLevel={3}
                title={state === "unread" ? "未読の通知はありません。" : "まだ通知はありません。"} />
            ) : (
              // 絞り込み・ページが変わったら、既読の案内を残さないよう作り直す。
              <NotificationList key={query.toString()} items={result.items} headingId={headingId} />
            )}
            {continued || nextPage ? (
              <p className={styles.pager}>
                {continued ? <Link className={styles.secondaryLink} href={firstPage}>最初のページを表示</Link> : null}
                {nextPage ? <Link className={styles.secondaryLink} href={nextPage}>次の{result.page.limit}件を表示</Link> : null}
              </p>
            ) : null}
          </section>
        )}
      </div>
    </AppShell>
  );
}
