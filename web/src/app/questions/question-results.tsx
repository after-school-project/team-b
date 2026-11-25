import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { EmptyState } from "@/components/feedback/StateMessage";
import type { QuestionListItem } from "@/qa/questions";
import { formatDateTime, resolutionLabels } from "./labels";
import styles from "./page.module.css";

type QuestionResultsProps = {
  items: QuestionListItem[];
  page: PageInfo;
  /** 検索条件を指定しているか。 */
  filtered: boolean;
  /** 2ページ目以降（カーソル付き）を表示しているか。 */
  continued: boolean;
  /** 検索条件を保ったまま先頭ページを表示するURL。 */
  firstPageHref: string;
  /** 次のページのURL。なければ null。 */
  nextPageHref: string | null;
};

/**
 * Q&A一覧の結果（QA-01）。
 * ページ送りの途中で質問の削除や非表示があると、該当する質問が残っていても続きのページが空になる。
 * この場合は「ありません」と表示せず、検索条件を保ったまま先頭ページへ戻る導線を示す。
 */
export function QuestionResults({ items, page, filtered, continued, firstPageHref, nextPageHref }: QuestionResultsProps) {
  const changedWhilePaging = items.length === 0 && continued && page.totalCount > 0;
  return (
    <section className={styles.results} aria-labelledby="question-results">
      <h2 id="question-results" className={styles.sectionTitle}>
        質問 <span className={styles.count}>{page.totalCount}件</span>
      </h2>
      {changedWhilePaging ? (
        <div className={styles.notice} role="status">
          <p>一覧が変わったため、この続きに表示できる質問はありません。最初のページから確認してください。</p>
        </div>
      ) : items.length === 0 ? (
        filtered
          ? <EmptyState title="条件に合う質問はありません。" headingLevel={3} description="キーワードや絞り込みを変えて検索してください。" />
          : <EmptyState title="まだ質問はありません。" headingLevel={3} />
      ) : (
        <ul className={styles.list}>
          {items.map((question) => (
            <li key={question.id} className={styles.item}>
              <p className={styles.badges}>
                <span className={styles.badgeInfo}>{question.category.name}</span>
                <span className={question.resolution === "resolved" ? styles.badgeSuccess : styles.badgeWarning}>
                  {resolutionLabels[question.resolution]}
                </span>
              </p>
              <h3 className={styles.itemTitle}><Link href={`/questions/${question.id}`}>{question.title}</Link></h3>
              <p className={styles.meta}>
                {question.author.displayName}・
                <time dateTime={question.createdAt}>{formatDateTime(question.createdAt)}</time>
                ・回答・コメント {question.responseCount}件
              </p>
            </li>
          ))}
        </ul>
      )}
      {continued || nextPageHref ? (
        <p className={styles.pager}>
          {continued ? <Link className={styles.secondaryLink} href={firstPageHref}>最初のページを表示</Link> : null}
          {nextPageHref ? <Link className={styles.secondaryLink} href={nextPageHref}>次の{page.limit}件を表示</Link> : null}
        </p>
      ) : null}
    </section>
  );
}
