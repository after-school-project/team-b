import type { Metadata } from "next";
import Link from "next/link";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { NoticeBreadcrumbs } from "../components";
import { NoticeForm } from "../notice-forms";
import { myNoticeHref, noticeListPosition } from "../notice-links";
import styles from "../notices.module.css";

export const metadata: Metadata = { title: "お知らせを作成" };

export default async function NewNoticePage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell } = await requireAppScreen("/notices/new", params);
  const canCreate = viewer.profileState === "public" && viewer.baseRole !== "student";
  const fromMine = params.from === "mine";
  const position = fromMine ? noticeListPosition(params) : new URLSearchParams();
  const cancelHref = fromMine ? myNoticeHref({}, position) : "/notices";
  return (
    <AppShell viewer={shell}>
      <div className={styles.formPage}>
        <NoticeBreadcrumbs items={[{ label: fromMine ? "自分のお知らせ" : "お知らせ", href: cancelHref }, { label: "新規作成" }]} />
        {canCreate ? <NoticeForm mode="create" submission={viewer.baseRole === "staff" ? "publish" : "review"}
          cancelHref={cancelHref} listSearch={position.toString()} /> : (
          <>
            <h1 className={styles.title}>お知らせを作成できません</h1>
            <p className={styles.lead}>{viewer.profileState !== "public"
              ? "プロフィールが非表示の間は、新しいお知らせを投稿できません。"
              : "お知らせを投稿できるのは学校職員と卒業生です。"}</p>
            <Link className={styles.secondaryButton} href={cancelHref}>一覧へ戻る</Link>
          </>
        )}
      </div>
    </AppShell>
  );
}
