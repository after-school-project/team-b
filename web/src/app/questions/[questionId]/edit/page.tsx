import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { listQuestionCategories, loadQuestion } from "@/qa/questions";
import styles from "../../page.module.css";
import { QuestionForm } from "../../question-form";

export const metadata: Metadata = { title: "質問の編集" };

export default async function EditQuestionPage({ params, searchParams }: {
  params: Promise<{ questionId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { questionId } = await params;
  const { viewer, shell } = await requireAppScreen(`/questions/${encodeURIComponent(questionId)}/edit`, await searchParams);
  const id = uuid.safeParse(questionId);
  if (!id.success) notFound();
  const question = await readForScreen((db) => loadQuestion(db, viewer, id.data)).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  if (!question.capabilities.canEdit || question.content === null) notFound();
  const { title, bodyMarkdown, category } = question.content;
  const categories = await readForScreen(listQuestionCategories);
  return (
    <AppShell viewer={shell}>
      <div className={styles.formPage}>
        <h1 className={styles.title}>質問の編集</h1>
        <QuestionForm categories={categories} cancelHref={`/questions/${id.data}`}
          edit={{ id: id.data, version: question.version, values: { title, bodyMarkdown, categoryCode: category.code } }} />
      </div>
    </AppShell>
  );
}
