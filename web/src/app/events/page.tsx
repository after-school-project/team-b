import type { Metadata } from "next";
import Link from "next/link";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { EmptyState } from "@/components/feedback/StateMessage";
import { readForScreen } from "@/db/screen-read";
import { listEvents, parseEventQuery } from "@/events/event-list";
import { formatEventDateTime, formatLabels, holdingLabels } from "./labels";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "イベント" };

export default async function EventsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const raw = await searchParams;
  const { viewer, shell } = await requireAppScreen("/events", raw);
  const query = new URLSearchParams();
  for (const name of ["q", "state", "sort", "limit", "cursor"]) {
    const value = raw[name];
    if (Array.isArray(value)) value.forEach((part) => query.append(name, part));
    else if (typeof value === "string" && (name !== "q" || value.trim())) query.set(name, value);
  }

  let result: Awaited<ReturnType<typeof listEvents>> | undefined;
  let errorCode: string | undefined;
  try {
    const filters = parseEventQuery(new URL(`http://app/events?${query}`));
    const referenceTime = new Date();
    result = await readForScreen((db) => db.transaction((tx) => listEvents(tx, viewer, filters, referenceTime), {
      isolationLevel: "repeatable read", accessMode: "read only",
    }));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    errorCode = error.code;
  }

  const navigationQuery = new URLSearchParams(query);
  navigationQuery.delete("cursor");
  const firstPage = navigationQuery.size ? `/events?${navigationQuery}` : "/events";
  if (result?.page.nextCursor) navigationQuery.set("cursor", result.page.nextCursor);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <h1 className={styles.title}>イベント</h1>
        <form action="/events" method="get" role="search" aria-label="イベントの検索条件" className={styles.panel}>
          <label className={styles.field}>キーワード
            <input name="q" defaultValue={query.get("q") ?? ""} />
          </label>
          <div className={styles.selects}>
            <label className={styles.field}>開催状態
              <select name="state" defaultValue={query.get("state") ?? "all"}>
                <option value="all">すべて</option>
                {Object.entries(holdingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className={styles.field}>並び順
              <select name="sort" defaultValue={query.get("sort") ?? "created_desc"}>
                <option value="created_desc">登録日時が新しい順</option>
                <option value="starts_asc">開催日時が近い順</option>
              </select>
            </label>
          </div>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary}>検索する</button>
            <button type="submit" form="event-clear" className={styles.clear}>条件をクリア</button>
          </div>
        </form>
        <form id="event-clear" action="/events" method="get" hidden />

        {errorCode ? (
          <div role="alert" className={styles.warning}>
            <p>{errorCode === "INVALID_CURSOR" ? "イベントの続きを表示できませんでした。" : "検索条件を確認してください。キーワードは100文字以内で入力してください。"}</p>
            {errorCode === "INVALID_CURSOR" && <Link href={firstPage}>最初のページを表示</Link>}
          </div>
        ) : null}
        {result && (
          <section aria-labelledby="event-results" className={styles.section}>
            <h2 id="event-results">イベント {result.page.totalCount}件</h2>
            {result.data.items.length === 0 ? (
              <EmptyState headingLevel={3} title={query.has("cursor") && result.page.totalCount > 0
                ? "一覧が変わったため、この続きに表示できるイベントはありません。"
                : "条件に合うイベントはありません。"} />
            ) : (
              <ul className={styles.list}>
                {result.data.items.map((event) => (
                  <li key={event.id} className={styles.panel}>
                    <p className={styles.meta}><span className={styles.badge}>{holdingLabels[event.holdingState]}</span> {formatLabels[event.format]}</p>
                    <h3>{event.title}</h3>
                    <p className={styles.meta}><time dateTime={event.startsAt}>{formatEventDateTime(event.startsAt)}</time>（日本時間）</p>
                  </li>
                ))}
              </ul>
            )}
            {(query.has("cursor") || result.page.nextCursor) && (
              <nav aria-label="イベント一覧のページ" className={styles.actions}>
                {query.has("cursor") && <Link className={styles.secondary} href={firstPage}>最初のページを表示</Link>}
                {result.page.nextCursor && <Link className={styles.secondary} href={`/events?${navigationQuery}`}>次の{result.page.limit}件を表示</Link>}
              </nav>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
