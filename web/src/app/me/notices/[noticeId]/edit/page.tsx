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
import { NoticeForm } from "@/app/notices/components";
import styles from "@/app/notices/notices.module.css";

export const metadata: Metadata = { title: "お知らせを編集" };

export default async function EditNoticePage({ params, searchParams }: {
  params: Promise<{ noticeId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { noticeId } = await params;
  const { viewer, shell } = await requireAppScreen(`/me/notices/${encodeURIComponent(noticeId)}/edit`, await searchParams);
  const id = uuid.safeParse(noticeId);
  if (!id.success) notFound();
  let notice;
  try {
    notice = await readForScreen((db) => loadMyNotice(db, viewer, id.data));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const editable = notice.capabilities.canEdit && notice.publicContent !== null;
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        {editable ? (
          <NoticeForm mode="edit" initialContent={notice.publicContent!} noticeId={notice.id} expectedVersion={notice.version} />
        ) : (
          <section className={styles.notice} role="status">
            <h1 className={styles.title}>編集できません</h1>
            <p>審査中、削除済み、または編集できない状態のお知らせです。</p>
            <Link href={`/me/notices?notice=${encodeURIComponent(notice.id)}`}>自分のお知らせへ戻る</Link>
          </section>
        )}
      </div>
    </AppShell>
  );
}
