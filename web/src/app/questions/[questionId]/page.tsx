import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { loadQuestion, type QuestionView } from "@/qa/questions";
import { QuestionDetail } from "./question-detail";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "質問" };

/** QA-02 Q&A詳細。質問の本体を表示する。回答・コメント・返信の表示と投稿は、#9 の後続のPRで追加する。 */
export default async function QuestionPage({ params, searchParams }: {
  params: Promise<{ questionId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { questionId } = await params;
  const { viewer, shell } = await requireAppScreen(`/questions/${encodeURIComponent(questionId)}`, await searchParams);
  const id = uuid.safeParse(questionId);
  if (!id.success) notFound();

  let question: QuestionView;
  try {
    question = await readForScreen((db) => loadQuestion(db, viewer, id.data));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.back}><Link href="/questions">Q&A一覧へ</Link></p>
        <QuestionDetail question={question} />
        <section className={styles.responses} aria-labelledby="question-responses">
          <h2 id="question-responses" className={styles.sectionTitle}>回答・コメント</h2>
          <p className={styles.pending}>回答・コメントの表示は準備中です。</p>
        </section>
      </div>
    </AppShell>
  );
}
