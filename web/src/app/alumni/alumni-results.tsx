import Link from "next/link";
import type { PageInfo } from "@/api/response";
import { EmptyState } from "@/components/feedback/StateMessage";
import type { PublicProfile } from "@/profile/public-profile";
import styles from "./page.module.css";

const baseRoleLabels: Record<PublicProfile["baseRole"], string> = { student: "在校生", alumni: "卒業生", staff: "学校職員" };

type AlumniResultsProps = {
  items: PublicProfile[];
  page: PageInfo;
  /** 2ページ目以降（カーソル付き）を表示しているか。 */
  continued: boolean;
  /** 検索条件を保ったまま先頭ページを表示するURL。 */
  firstPageHref: string;
  /** 次のページのURL。なければ null。 */
  nextPageHref: string | null;
};

/**
 * 卒業生検索の結果。
 * ページ送りの途中で掲載の取り消しや非表示があると、該当者が残っていても続きのページが空になる。
 * この場合は「いません」と表示せず、検索条件を保ったまま先頭ページへ戻る導線を示す。
 */
export function AlumniResults({ items, page, continued, firstPageHref, nextPageHref }: AlumniResultsProps) {
  const changedWhilePaging = items.length === 0 && continued && page.totalCount > 0;
  return (
    <section className={styles.results} aria-labelledby="alumni-results">
      <h2 id="alumni-results" className={styles.sectionTitle}>
        検索結果 <span className={styles.count}>{page.totalCount}件</span>
      </h2>
      {changedWhilePaging ? (
        <div className={styles.notice} role="status">
          <p>検索結果が変わったため、この続きに表示できる人はいません。最初のページから確認してください。</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="条件に合う卒業生・卒業予定者はいません。" headingLevel={3}
          description="キーワードや年度を変えて検索してください。" />
      ) : (
        <ul className={styles.list}>
          {items.map((profile) => (
            <li key={profile.userId} className={styles.item}>
              <p className={styles.badges}>
                <span className={styles.badgeInfo}>{baseRoleLabels[profile.baseRole]}</span>
                {profile.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}
              </p>
              <h3 className={styles.itemTitle}>
                <Link href={`/users/${encodeURIComponent(profile.userId)}`}>{profile.fields.displayName}</Link>
              </h3>
              {profile.fields.optionalFields.occupation?.value ? (
                <p className={styles.summary}>{profile.fields.optionalFields.occupation.value}</p>
              ) : null}
              <p className={styles.meta}>
                {[profile.fields.department, profile.fields.graduationYear ? `${profile.fields.graduationYear}年度卒業` : null]
                  .filter(Boolean).join("・") || "学科・年度の登録なし"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {continued || nextPageHref ? (
        <p className={styles.pager}>
          {continued ? <Link className={styles.secondaryLink} href={firstPageHref}>最初のページを表示</Link> : null}
          {nextPageHref ? (
            <Link className={styles.secondaryLink} href={nextPageHref}>次の{page.limit}件を表示</Link>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
