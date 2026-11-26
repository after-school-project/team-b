import type { Metadata } from "next";
import Link from "next/link";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { NoticeForm } from "../components";
import styles from "../notices.module.css";

export const metadata: Metadata = { title: "お知らせを作成" };

export default async function NewNoticePage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const { viewer, shell } = await requireAppScreen("/notices/new", await searchParams);
  const canCreate = viewer.profileState === "public" && viewer.baseRole !== "student";
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        {canCreate ? <NoticeForm mode="create" /> : (
          <section className={styles.notice} role="status">
            <h1 className={styles.title}>お知らせを作成できません</h1>
            <p>{viewer.profileState !== "public"
              ? "プロフィールが非表示の間は、新しいお知らせを投稿できません。"
              : "お知らせを投稿できるのは学校職員と卒業生です。"}</p>
            <Link href="/notices">お知らせ一覧へ戻る</Link>
          </section>
        )}
      </div>
    </AppShell>
  );
}
