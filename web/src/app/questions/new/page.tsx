import type { Metadata } from "next";
import Link from "next/link";
import { canWriteContent } from "@/auth/access";
import { resolveReturnTo } from "@/auth/return-to";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { listQuestionCategories } from "@/qa/questions";
import styles from "../page.module.css";
import { QuestionForm } from "../question-form";

export const metadata: Metadata = { title: "質問の新規作成" };

export default async function NewQuestionPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell } = await requireAppScreen("/questions/new", params);
  const writable = canWriteContent(viewer);
  const from = resolveReturnTo(params.from);
  const cancelHref = from === "/questions" || from.startsWith("/questions?") ? from : "/questions";

  return (
    <AppShell viewer={shell}>
      <div className={styles.formPage}>
        <h1 className={styles.title}>質問の新規作成</h1>
        {writable ? (
          <QuestionForm categories={await readForScreen(listQuestionCategories)} cancelHref={cancelHref} />
        ) : (
          <div className={styles.formError}>
            <p>プロフィールが非表示の間は、質問を投稿できません。</p>
            <Link href={cancelHref}>Q&A一覧へ</Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}
