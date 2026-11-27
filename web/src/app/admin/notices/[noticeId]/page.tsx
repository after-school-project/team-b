import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { loadAdminNotice, loadAdminNoticeRequest } from "@/notices/admin";
import { NOTICE_CATEGORY } from "@/notices/category";
import type { ManagedContent, NoticeContent, ReviewRequest } from "@/notices/notices";
import styles from "../../admin.module.css";
import { formatDateTime } from "../../labels";
import { originLabels, publicationBadge, publicationLabels, requestKindLabels, reviewBadge, reviewLabels } from "../labels";
import { NoticeAction } from "../notice-action";

export const metadata: Metadata = { title: "お知らせの管理詳細" };

function Content({ content }: { content: NoticeContent }) {
  return (
    <dl className={styles.details}>
      <div><dt>カテゴリー</dt><dd>{NOTICE_CATEGORY.name}</dd></div>
      <div><dt>本文</dt><dd className={styles.multiline}>{content.body}</dd></div>
    </dl>
  );
}

function Review({ request }: { request: ReviewRequest }) {
  return (
    <section className={styles.operationCard} aria-label="申請の内容">
      <h2 className={styles.sectionTitle}>{request.content.title}</h2>
      <p className={styles.badges}><span className={reviewBadge[request.status]}>{reviewLabels[request.status]}</span></p>
      <dl className={styles.details}>
        <div><dt>申請種別</dt><dd>{requestKindLabels[request.kind]}</dd></div>
        <div><dt>申請者</dt><dd>{request.applicant.displayName}</dd></div>
        <div><dt>申請日時</dt><dd>{formatDateTime(request.submittedAt)}</dd></div>
        {request.decidedAt ? <div><dt>審査日時</dt><dd>{formatDateTime(request.decidedAt)}</dd></div> : null}
        {request.decisionReason ? <div><dt>却下の理由</dt><dd className={styles.multiline}>{request.decisionReason}</dd></div> : null}
      </dl>
      <Content content={request.content} />
      {request.status === "pending" && !request.capabilities.canReview
        ? <p className={styles.text}>自分の申請は審査できません。</p> : null}
      <NoticeAction key={request.id} id={request.id} version={request.version}
        action={request.capabilities.canReview ? "review" : null} />
      {request.status === "approved" ? <p className={styles.links}>
        <Link href={`/admin/notices/${request.resourceId}`}>公開管理の詳細へ</Link>
      </p> : null}
    </section>
  );
}

function Publication({ notice }: { notice: ManagedContent }) {
  const content = notice.publicContent ?? notice.deletedContent;
  if (!content) return null;
  const action = notice.capabilities.canHide ? "hidden" : notice.capabilities.canRestore ? "public" : null;
  return (
    <section className={styles.operationCard} aria-label="公開管理の詳細">
      <h2 className={styles.sectionTitle}>{content.title}</h2>
      <p className={styles.badges}>
        <span className={publicationBadge[notice.publicationState]}>{publicationLabels[notice.publicationState]}</span>
      </p>
      <dl className={styles.details}>
        <div><dt>投稿区分</dt><dd>{originLabels[notice.originKind]}</dd></div>
        <div><dt>投稿者</dt><dd>{notice.author.displayName}</dd></div>
        {notice.deletedAt ? <div><dt>削除日時</dt><dd>{formatDateTime(notice.deletedAt)}</dd></div> : null}
        {notice.retentionExpiresAt ? <div><dt>閲覧期限</dt><dd>{formatDateTime(notice.retentionExpiresAt)}</dd></div> : null}
      </dl>
      <Content content={content} />
      {notice.pendingRequest ? <p className={styles.links}>
        <Link href={`/admin/notices/${notice.id}?request=${notice.pendingRequest.id}`}>承認待ちの編集申請へ</Link>
      </p> : null}
      {notice.publicationState === "deleted" ? <p className={styles.text}>削除済みのお知らせは復元できません。</p> : null}
      <NoticeAction key={notice.id} id={notice.id} version={notice.version} action={action} />
    </section>
  );
}

export default async function AdminNoticePage({ params, searchParams }: {
  params: Promise<{ noticeId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const [{ noticeId }, query] = await Promise.all([params, searchParams]);
  const { viewer, shell, access } = await requireAdminScreen("any", `/admin/notices/${noticeId}`, query);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (!uuid.safeParse(noticeId).success) notFound();

  const isReview = query.request !== undefined;
  const requestId = isReview ? uuid.safeParse(query.request) : null;
  if (requestId?.success === false) notFound();
  const detail = await readForScreen<ReviewRequest | ManagedContent>((db) => requestId
    ? loadAdminNoticeRequest(db, viewer, requestId.data, noticeId)
    : loadAdminNotice(db, viewer, noticeId),
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.links}>
          <Link href={isReview ? "/admin/notices" : "/admin/notices?view=publication"}>
            {isReview ? "審査一覧へ" : "公開管理一覧へ"}
          </Link>
        </p>
        <h1 className={styles.title}>{isReview ? "お知らせの申請詳細" : "お知らせの公開管理"}</h1>
        {"resourceId" in detail ? <Review request={detail} /> : <Publication notice={detail} />}
      </div>
    </AppShell>
  );
}
