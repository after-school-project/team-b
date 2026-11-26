import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { loadMyNotice } from "@/notices/notices";
import { NoticeBreadcrumbs } from "@/app/notices/components";
import { NoticeForm } from "@/app/notices/notice-forms";
import { myNoticeHref, noticeListPosition } from "@/app/notices/notice-links";
import styles from "@/app/notices/notices.module.css";

export const metadata: Metadata = { title: "お知らせを編集" };

export default async function EditNoticePage({ params, searchParams }: {
  params: Promise<{ noticeId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { noticeId } = await params;
  const search = await searchParams;
  const { viewer, shell } = await requireAppScreen(`/me/notices/${encodeURIComponent(noticeId)}/edit`, search);
  const id = uuid.safeParse(noticeId);
  if (!id.success) notFound();

  let notice;
  try {
    notice = await readForScreen((db) => loadMyNotice(db, viewer, id.data));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const position = noticeListPosition(search);
  const cancelHref = myNoticeHref({ noticeId: notice.id }, position);
  const submission = viewer.baseRole === "staff"
    ? notice.publicationState === "hidden" ? "hidden" : "publish"
    : "review";
  return (
    <AppShell viewer={shell}>
      <div className={styles.formPage}>
        <NoticeBreadcrumbs items={[
          { label: "自分のお知らせ", href: myNoticeHref({}, position) },
          { label: (notice.deletedContent ?? notice.publicContent)?.title ?? "お知らせ詳細", href: cancelHref },
          { label: "編集" },
        ]} />
        {notice.capabilities.canEdit && notice.publicContent ? (
          <NoticeForm key={notice.id} mode="edit" submission={submission} initialContent={notice.publicContent}
            noticeId={notice.id} expectedVersion={notice.version} cancelHref={cancelHref} listSearch={position.toString()} />
        ) : (
          <>
            <h1 className={styles.title}>編集できません</h1>
            <p className={styles.lead}>審査中、削除済み、または編集できない状態のお知らせです。</p>
            <Link className={styles.secondaryButton} href={cancelHref}>お知らせ詳細へ戻る</Link>
          </>
        )}
      </div>
    </AppShell>
  );
}
