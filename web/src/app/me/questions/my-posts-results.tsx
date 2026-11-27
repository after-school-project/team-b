import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { EmptyState } from "@/components/feedback/StateMessage";
import type { MyQaItem, MyQaKind } from "@/qa/my-posts";
import { formatDateTime } from "../../questions/labels";
import listStyles from "../../questions/page.module.css";
import styles from "./page.module.css";

export const myQaKindLabels: Record<MyQaKind, string> = {
  question: "質問", answer: "回答", comment: "コメント", reply: "返信",
};

/** 一覧の見出し。質問は題名、回答等は親の質問の題名を示す。題名を返さない質問は状態で示す。 */
function itemTitle(item: MyQaItem): string {
  if (item.kind === "question") return item.questionTitle ?? "表示できない質問";
  const kind = myQaKindLabels[item.kind];
  if (item.questionTitle !== null) return `「${item.questionTitle}」への${kind}`;
  return item.questionState === "deleted" ? `削除された質問への${kind}` : `表示できない質問への${kind}`;
}

/**
 * 自分のQ&A投稿の一覧（GE-05）。各投稿から QA-02 へ移動する。
 * 削除済みの質問の題名は表示せず、その下に残る自分の回答等への導線だけを示す。
 */
export function MyPostsResults({ items, page, kind, continued, firstPageHref, nextPageHref }: {
  items: MyQaItem[];
  page: PageInfo;
  kind: MyQaKind | "all";
  continued: boolean;
  firstPageHref: string;
  nextPageHref: string | null;
}) {
  const changedWhilePaging = items.length === 0 && continued && page.totalCount > 0;
  return (
    <section className={listStyles.results} aria-labelledby="my-posts-results">
      <h2 id="my-posts-results" className={listStyles.sectionTitle}>
        {kind === "all" ? "投稿" : myQaKindLabels[kind]} <span className={listStyles.count}>{page.totalCount}件</span>
      </h2>
      {changedWhilePaging ? (
        <div className={listStyles.notice} role="status">
          <p>一覧が変わったため、この続きに表示できる投稿はありません。最初のページから確認してください。</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={kind === "all" ? "まだ投稿はありません。" : `${myQaKindLabels[kind]}の投稿はありません。`}
          headingLevel={3} />
      ) : (
        <ul className={listStyles.list}>
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className={listStyles.item}>
              <p className={listStyles.badges}>
                <span className={item.kind === "question" ? listStyles.badgeInfo : styles.badgeNeutral}>
                  {myQaKindLabels[item.kind]}
                </span>
                {item.questionState === "deleted" ? <span className={styles.badgeNeutral}>質問は削除済み</span> : null}
                {item.questionState === "hidden" ? <span className={styles.badgeNeutral}>
                  {item.kind === "question" ? "非表示" : "質問は非表示"}
                </span> : null}
              </p>
              <h3 className={listStyles.itemTitle}><Link href={item.targetPath}>{itemTitle(item)}</Link></h3>
              {item.excerpt ? <p className={styles.excerpt}>{item.excerpt}</p> : null}
              <p className={listStyles.meta}>
                <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {continued || nextPageHref ? (
        <p className={listStyles.pager}>
          {continued ? <Link className={listStyles.secondaryLink} href={firstPageHref}>最初のページを表示</Link> : null}
          {nextPageHref ? <Link className={listStyles.secondaryLink} href={nextPageHref}>次の{page.limit}件を表示</Link> : null}
        </p>
      ) : null}
    </section>
  );
}
