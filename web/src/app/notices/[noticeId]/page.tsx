import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { loadPublicNotice } from "@/notices/notices";
import { NoticeBreadcrumbs, PublicNoticeDetail } from "../components";
import { withNoticeQuery } from "../notice-links";
import styles from "../notices.module.css";

export const metadata: Metadata = { title: "お知らせ" };

export default async function NoticePage({ params, searchParams }: {
  params: Promise<{ noticeId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { noticeId } = await params;
  const search = await searchParams;
  const { shell } = await requireAppScreen(`/notices/${encodeURIComponent(noticeId)}`, search);
  const parsedId = uuid.safeParse(noticeId);
  if (!parsedId.success) notFound();

  let notice;
  try {
    notice = await readForScreen((db) => loadPublicNotice(db, parsedId.data));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const position = new URLSearchParams();
  for (const key of ["q", "cursor"] as const) {
    if (typeof search[key] === "string" && search[key]) position.set(key, search[key]);
  }
  return (
    <AppShell viewer={shell}>
      <div className={styles.readingPage}>
        <NoticeBreadcrumbs items={[{ label: "お知らせ", href: withNoticeQuery("/notices", position) }, { label: "公開詳細" }]} />
        <PublicNoticeDetail notice={notice} />
      </div>
    </AppShell>
  );
}
