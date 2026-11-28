import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import { canWriteContent } from "@/auth/access";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { ReportButton } from "@/components/report/ReportButton";
import { readForScreen } from "@/db/screen-read";
import { loadQuestion, type QuestionView } from "@/qa/questions";
import { listResponses } from "@/qa/responses";
import { QuestionDelete } from "./delete-confirm";
import { QuestionDetail } from "./question-detail";
import { ResolutionToggle } from "./resolution-toggle";
import { ResponseThread } from "./response-thread";
import { VisibilityAction } from "./visibility-action";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "質問" };

/** 質問の本体の枠のID。質問を削除した後のフォーカス先。 */
const questionAreaId = "question-area";

/** 最初に表示する回答・コメント・返信の件数。続きは画面の「さらに表示」で読み込む。 */
const firstPageLimit = 50;

/**
 * QA-02 Q&A詳細。質問の本体と、回答・コメント・返信のスレッド・投稿フォームを表示する。
 * 質問が削除・非表示でも、残存する回答等はそれぞれの状態で表示する。質問者本人は、解決状態の変更・編集・削除ができる。
 */
export default async function QuestionPage({ params, searchParams }: {
  params: Promise<{ questionId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { questionId } = await params;
  const { viewer, shell } = await requireAppScreen(`/questions/${encodeURIComponent(questionId)}`, await searchParams);
  const id = uuid.safeParse(questionId);
  if (!id.success) notFound();

  let question: QuestionView;
  let responses: Awaited<ReturnType<typeof listResponses>>;
  try {
    [question, responses] = await readForScreen((db) => Promise.all([
      loadQuestion(db, viewer, id.data),
      listResponses(db, viewer, id.data, { limit: firstPageLimit, cursor: undefined }),
    ]));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const unavailableReason = question.publicationState !== "public"
    ? "この質問には新しい回答・コメントを投稿できません。"
    : canWriteContent(viewer) ? null : "プロフィールが非表示のため、回答・コメント・返信を投稿できません。";

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.back}><Link href="/questions">Q&A一覧へ</Link></p>
        {/* 質問を削除すると、この枠へフォーカスを移してから再取得する。枠は再取得の後も同じ要素として残る。 */}
        <div id={questionAreaId} className={styles.questionArea} tabIndex={-1}>
          <QuestionDetail question={question} />
        </div>
        {question.content !== null && (question.capabilities.canEdit || question.capabilities.canDelete
          || question.capabilities.canResolve || question.capabilities.canHide || question.capabilities.canRestore || question.capabilities.canReport) ? (
          <div className={styles.ownerActions}>
            {question.capabilities.canResolve && question.version !== null ? (
              <ResolutionToggle questionId={question.id} version={question.version} resolution={question.resolution} />
            ) : null}
            {question.capabilities.canEdit ? <Link href={`/questions/${question.id}/edit`}>質問を編集</Link> : null}
            {question.capabilities.canDelete && question.version !== null ? (
              <QuestionDelete questionId={question.id} version={question.version} title={question.content.title}
                focusTargetId={questionAreaId} />
            ) : null}
            {question.capabilities.canHide || question.capabilities.canRestore ? (
              <VisibilityAction target="question" id={question.id} kind="質問" version={question.version}
                visibility={question.capabilities.canHide ? "hidden" : "public"} />
            ) : null}
            {question.capabilities.canReport ? <ReportButton type="question" id={question.id} label={question.content.title} /> : null}
          </div>
        ) : null}
        <section className={styles.responses} aria-labelledby="question-responses">
          <h2 id="question-responses" className={styles.sectionTitle}>回答・コメント</h2>
          <ResponseThread questionId={question.id} canAnswer={question.capabilities.canRespond}
            unavailableReason={unavailableReason}
            initial={{ items: responses.data.items, nextCursor: responses.page.nextCursor }} />
        </section>
      </div>
    </AppShell>
  );
}
