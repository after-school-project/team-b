import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError, type PageInfo } from "@/api/response";
import type { Viewer } from "@/auth/access";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import {
  listMyNoticeRequests, loadMyNotice, loadMyNoticeRequest, parseMyNoticeQuery, parseRequestQuery, searchMyNotices,
  type ManagedNoticeListItem,
} from "@/notices/notices";
import {
  ManagedNoticeDetail, ManagedNoticeHeader, MyNoticeFilter, MyNoticeResults, NoticeBreadcrumbs,
  NoticeRequests, NoticeRequestDetail, NoticeSectionNav,
} from "@/app/notices/components";
import { ConfirmNoticeAction, NoticeForm } from "@/app/notices/notice-forms";
import { myNoticeHref, noticeListPosition, withNoticeQuery } from "@/app/notices/notice-links";
import styles from "@/app/notices/notices.module.css";

export const metadata: Metadata = { title: "自分のお知らせ" };

function invalidParameters(params: ScreenSearchParams, allowed: readonly string[]) {
  return Object.entries(params).some(([key, value]) => !allowed.includes(key) || Array.isArray(value));
}

function readOwned<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
}

async function NoticeList({ viewer, params, position }: {
  viewer: Viewer; params: ScreenSearchParams; position: URLSearchParams;
}) {
  let items: ManagedNoticeListItem[] = [];
  let page: PageInfo = { limit: 20, totalCount: 0, nextCursor: null, hasMore: false };
  let invalid = invalidParameters(params, ["state", "sort", "cursor"]) ? "一覧条件を確認してください。" : null;
  if (!invalid) {
    try {
      const query = parseMyNoticeQuery(new URL(withNoticeQuery("http://app/me/notices", position)));
      const result = await readForScreen((db) => searchMyNotices(db, viewer, query));
      items = result.data.items;
      page = result.page;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      invalid = error.code === "INVALID_CURSOR" ? "一覧の続きを表示できませんでした。" : "一覧条件を確認してください。";
    }
  }
  const canCreate = viewer.profileState === "public" && viewer.baseRole !== "student";
  return (
    <>
      <NoticeSectionNav current="mine" />
      <header className={styles.pageHeading}>
        <h1 className={styles.title}>自分のお知らせ</h1>
        {canCreate ? <Link className={styles.primaryButton} href={withNoticeQuery("/notices/new", new URLSearchParams({ from: "mine", ...Object.fromEntries(position) }))}>お知らせを作成</Link> : null}
      </header>
      <MyNoticeFilter state={position.get("state") ?? "all"} sort={position.get("sort") ?? "created_desc"} />
      {invalid ? (
        <div className={styles.formError} role="alert">
          <p>{invalid}</p>
          <Link href="/me/notices">一覧を開き直す</Link>
        </div>
      ) : <MyNoticeResults items={items} page={page} position={position} />}
    </>
  );
}

async function NoticeDetails({ viewer, params, position }: {
  viewer: Viewer; params: ScreenSearchParams; position: URLSearchParams;
}) {
  if (invalidParameters(params, ["notice", "request", "requestCursor", "state", "sort", "cursor", "action"])) notFound();
  const noticeId = uuid.safeParse(params.notice);
  if (!noticeId.success || (params.action && params.action !== "resubmit") || (params.action && !params.request)) notFound();

  const id = noticeId.data;
  const notice = await readOwned(() => readForScreen((db) => loadMyNotice(db, viewer, id)));
  const listHref = myNoticeHref({}, position);
  const requestCursor = typeof params.requestCursor === "string" ? params.requestCursor : undefined;
  const detailHref = myNoticeHref({ noticeId: id, requestCursor }, position);
  const title = (notice.deletedContent ?? notice.publicContent)?.title ?? "お知らせ";
  const listCrumb = { label: "自分のお知らせ", href: listHref };

  if (params.request !== undefined) {
    const requestId = uuid.safeParse(params.request);
    if (!requestId.success) notFound();
    const request = await readOwned(() => readForScreen((db) => loadMyNoticeRequest(db, viewer, requestId.data)));
    if (request.resourceId !== id) notFound();

    const requestOptions = { noticeId: id, requestId: request.id, requestCursor };
    const requestHref = myNoticeHref(requestOptions, position);
    const kind = request.kind === "new" ? "新規申請" : "編集申請";
    const detailCrumb = { label: title, href: detailHref };
    if (params.action === "resubmit") {
      if (!request.capabilities.canResubmit) return (
        <>
          <NoticeBreadcrumbs items={[listCrumb, detailCrumb, { label: kind, href: requestHref }, { label: "再申請" }]} />
          <h1 className={styles.title}>再申請できません</h1>
          <Link className={styles.secondaryButton} href={requestHref}>申請詳細へ戻る</Link>
        </>
      );
      return (
        <div className={styles.formPage}>
          <NoticeBreadcrumbs items={[listCrumb, detailCrumb, { label: kind, href: requestHref }, { label: "再申請" }]} />
          <NoticeForm key={request.id} mode="resubmit" submission="review" requestId={request.id} noticeId={id}
            initialContent={request.content} expectedVersion={request.version} cancelHref={requestHref}
            listSearch={position.toString()} />
        </div>
      );
    }
    return (
      <>
        <NoticeBreadcrumbs items={[listCrumb, detailCrumb, { label: kind }]} />
        <NoticeRequestDetail request={request} resubmitHref={myNoticeHref({ ...requestOptions, resubmit: true }, position)} />
      </>
    );
  }

  const history = await readOwned(() => readForScreen((db) => {
    const query = new URL("http://app/requests");
    if (requestCursor) query.searchParams.set("cursor", requestCursor);
    return listMyNoticeRequests(db, viewer, id, parseRequestQuery(query));
  })).catch((error: unknown) => {
    if (error instanceof ApiError && (error.code === "INVALID_CURSOR" || error.code === "BAD_REQUEST")) return null;
    throw error;
  });
  const nextCursor = history?.page.nextCursor;
  const firstPageHref = requestCursor ? myNoticeHref({ noticeId: id }, position) : undefined;
  const nextPageHref = nextCursor ? myNoticeHref({ noticeId: id, requestCursor: nextCursor }, position) : null;
  return (
    <>
      <NoticeBreadcrumbs items={[listCrumb, { label: "お知らせ詳細" }]} />
      <ManagedNoticeHeader notice={notice} editHref={withNoticeQuery(`/me/notices/${id}/edit`, position)} />
      <div className={styles.detailGrid}>
        <div className={styles.detailStack}>
          <ManagedNoticeDetail notice={notice} />
          {notice.capabilities.canDelete ? (
            <div className={styles.removeArea}>
              <ConfirmNoticeAction key={id} operation="delete" subject={title} target={id} version={notice.version}
                hasPendingEdit={notice.pendingRequest?.kind === "edit"} />
            </div>
          ) : null}
        </div>
        <NoticeRequests noticeId={id} items={history?.data.items ?? []} historyError={!history}
          firstPageHref={firstPageHref} nextPageHref={nextPageHref} position={position} requestCursor={requestCursor} />
      </div>
    </>
  );
}

export default async function MyNoticesPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell } = await requireAppScreen("/me/notices", params);
  const position = noticeListPosition(params);
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        {params.notice === undefined && params.request === undefined && params.action === undefined
          ? <NoticeList viewer={viewer} params={params} position={position} />
          : <NoticeDetails viewer={viewer} params={params} position={position} />}
      </div>
    </AppShell>
  );
}
