import Link from "next/link";
import { RestrictedMarkdown } from "@/components/markdown/RestrictedMarkdown";
import type { QuestionView } from "@/qa/questions";
import { formatDateTime, resolutionLabels } from "../labels";
import styles from "./page.module.css";

/**
 * 質問の本体（QA-02）。削除済み・閲覧できない強制非表示の質問は状態案内だけを表示する。
 * 強制非表示の内容を表示できる本人・管理者には、非表示中であることを示す。
 */
export function QuestionDetail({ question }: { question: QuestionView }) {
  if (question.content === null) {
    const deleted = question.publicationState === "deleted";
    return (
      <>
        <h1 className={styles.title}>質問</h1>
        <section className={styles.notice}>
          <span className={styles.badgeNeutral}>{deleted ? "削除済み" : "非表示"}</span>
          <p>{deleted ? "この質問は削除されました。" : "この質問は現在表示できません。"}</p>
        </section>
      </>
    );
  }

  const { title, bodyMarkdown, category } = question.content;
  return (
    <article className={styles.question}>
      <header className={styles.header}>
        <p className={styles.badges}>
          <span className={styles.badgeInfo}>{category.name}</span>
          <span className={question.resolution === "resolved" ? styles.badgeSuccess : styles.badgeWarning}>
            {resolutionLabels[question.resolution]}
          </span>
          {question.publicationState === "hidden" ? <span className={styles.badgeNeutral}>非表示</span> : null}
        </p>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.meta}>
          <Link href={`/users/${encodeURIComponent(question.author.userId)}`}>{question.author.displayName}</Link>・
          <time dateTime={question.createdAt}>{formatDateTime(question.createdAt)}</time>
        </p>
      </header>
      {question.publicationState === "hidden" ? (
        <div className={styles.notice}>
          <p>この質問は管理者により非表示になっています。内容は本人と権限のある管理者だけに表示されます。</p>
        </div>
      ) : null}
      <div className={styles.card}><RestrictedMarkdown source={bodyMarkdown} headingLevel={2} /></div>
    </article>
  );
}
