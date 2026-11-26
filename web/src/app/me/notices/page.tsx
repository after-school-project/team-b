import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError, type PageInfo } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import {
  listMyNoticeRequests, loadMyNotice, loadMyNoticeRequest, parseMyNoticeQuery, parseRequestQuery, searchMyNotices,
  type ManagedContent, type ManagedNoticeListItem, type RequestSummary, type ReviewRequest,
} from "@/notices/notices";
import {
  ManagedNoticeDetail, MyNoticeFilter, MyNoticeResults, NoticeActions, NoticeForm, NoticeRequests, NoticeRequestDetail,
} from "@/app/notices/components";
import styles from "@/app/notices/notices.module.css";

export const metadata: Metadata = { title: "自分のお知らせ" };

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? undefined : value;
}

function listQuery(resolved: ScreenSearchParams) {
  const query = new URLSearchParams();
  for (const key of ["state", "sort", "cursor"] as const) {
    const value = first(resolved[key]);
    if (value) query.set(key, value);
  }
  return query;
}

export default async function MyNoticesPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell } = await requireAppScreen("/me/notices", resolved);
  const rawNoticeId = first(resolved.notice);
  const rawRequestId = first(resolved.request);
  const rawState = first(resolved.state) ?? "all";
  const rawSort = first(resolved.sort) ?? "created_desc";
  const rawCursor = first(resolved.cursor);
  const malformed = ["notice", "request", "requestCursor", "state", "sort", "cursor"].some((key) =>
    Array.isArray(resolved[key])) || Object.keys(resolved).some((key) =>
    !["notice", "request", "requestCursor", "state", "sort", "cursor"].includes(key));

  let items: ManagedNoticeListItem[] = [];
  let page: PageInfo = { limit: 20, hasMore: false, nextCursor: null, totalCount: 0 };
  let invalid = malformed ? "一覧条件を確認してください。" : null;
  if (!invalid) {
    try {
      const query = parseMyNoticeQuery(new URL(`http://app/me/notices?${listQuery(resolved)}`));
      const result = await readForScreen((db) => searchMyNotices(db, viewer, query));
      items = result.data.items;
      page = result.page;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      invalid = error.code === "INVALID_CURSOR"
        ? "一覧の続きを表示できませんでした。最初のページから表示し直してください。"
        : "一覧条件を確認してください。";
    }
  }

  let notice: ManagedContent | null = null;
  let requestHistory: RequestSummary[] = [];
  let requestNextCursor: string | null = null;
  let selectedRequest: ReviewRequest | null = null;
  if (rawRequestId && !rawNoticeId) notFound();
  if (rawNoticeId) {
    const parsedNoticeId = uuid.safeParse(rawNoticeId);
    if (!parsedNoticeId.success) notFound();
    try {
      notice = await readForScreen((db) => loadMyNotice(db, viewer, parsedNoticeId.data));
      const historyQuery = new URLSearchParams();
      const requestCursor = first(resolved.requestCursor);
      if (requestCursor) historyQuery.set("cursor", requestCursor);
      const history = await readForScreen((db) =>
        listMyNoticeRequests(db, viewer, parsedNoticeId.data, parseRequestQuery(new URL(`http://app/requests?${historyQuery}`))));
      requestHistory = history.data.items;
      requestNextCursor = history.page.nextCursor;
      if (rawRequestId) {
        const parsedRequestId = uuid.safeParse(rawRequestId);
        if (!parsedRequestId.success) notFound();
        selectedRequest = await readForScreen((db) => loadMyNoticeRequest(db, viewer, parsedRequestId.data));
        if (selectedRequest.resourceId !== notice.id) notFound();
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
      if (error instanceof ApiError && error.code === "INVALID_CURSOR") {
        invalid = "申請履歴の続きを表示できませんでした。履歴の先頭から確認してください。";
      } else {
        throw error;
      }
    }
  }

  const state = rawState;
  const sort = rawSort;
  const historyParams = new URLSearchParams({ notice: rawNoticeId ?? "" });
  if (rawRequestId) historyParams.set("request", rawRequestId);
  if (state !== "all") historyParams.set("state", state);
  if (sort !== "created_desc") historyParams.set("sort", sort);
  if (requestNextCursor) historyParams.set("requestCursor", requestNextCursor);
  const canCreate = viewer.profileState === "public" && viewer.baseRole !== "student";
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>自分のお知らせ</h1>
          <p className={styles.lead}>投稿・申請の状態と履歴を確認できます。</p>
        </header>
        {canCreate ? <p><Link className={styles.secondaryLink} href="/notices/new">お知らせを投稿する</Link></p> : null}
        <MyNoticeFilter state={state} sort={sort} />
        {invalid ? <p className={styles.notice} role="alert">{invalid}</p> : null}
        {!invalid ? (
          <MyNoticeResults items={items} page={page} state={state} sort={sort} cursor={rawCursor}
            selectedId={rawNoticeId} />
        ) : null}
        {notice ? (
          <section className={styles.managedView} aria-labelledby="selected-notice-heading">
            <h2 id="selected-notice-heading">選択したお知らせ</h2>
            <ManagedNoticeDetail notice={notice} />
            <NoticeActions notice={notice} request={selectedRequest ?? undefined} />
            <NoticeRequests items={requestHistory} selectedId={rawRequestId} noticeId={notice.id}
              nextPageHref={requestNextCursor ? `/me/notices?${historyParams}` : null} />
            {selectedRequest ? <NoticeRequestDetail request={selectedRequest} /> : null}
            {selectedRequest?.capabilities.canResubmit ? (
              <NoticeForm mode="resubmit" initialContent={selectedRequest.content} requestId={selectedRequest.id}
                expectedVersion={selectedRequest.version} />
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
