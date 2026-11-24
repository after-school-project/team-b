import type { Metadata } from "next";
import Link from "next/link";
import { uuid } from "@/api/request";
import type { PageInfo } from "@/api/response";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import {
  listProfileReviews, loadProfileReview, parseProfileReviewQuery, type ProfileReview, type ProfileReviewListItem,
} from "@/profile/profile-reviews";
import styles from "../admin.module.css";
import { formatDateTime, reviewStatusLabels } from "../labels";
import { ReviewDetail } from "./review-detail";
import { reviewsPath, reviewStatuses, type ReviewStatus } from "./reviews-path";

export const metadata: Metadata = { title: "プロフィール再公開審査" };

const statusBadges = { pending: styles.badgeWarning, approved: styles.badgeSuccess, rejected: styles.badgeDanger } as const;
const filterLabels: Record<ReviewStatus, string> = { ...reviewStatusLabels, all: "すべて" };

type ListResult =
  | { kind: "ok"; items: ProfileReviewListItem[]; page: PageInfo }
  | { kind: "invalid"; message: string };

/** 画面のクエリーから値を取り出す。同名の複数指定は形式の誤りとして扱う。 */
function single(searchParams: ScreenSearchParams, name: string): { value: string; malformed: boolean } {
  const raw = searchParams[name];
  return { value: typeof raw === "string" ? raw : "", malformed: Array.isArray(raw) };
}

/** AD-15 プロフィール再公開審査。申請の一覧と、選択した申請の詳細・承認・却下を同じ画面に表示する（#8 ⑤）。 */
export default async function ProfileReviewsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const resolved = await searchParams;
  const { viewer, shell, access } = await requireAdminScreen("any", "/admin/profile-reviews", resolved);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;

  const statusParam = single(resolved, "status");
  const cursorParam = single(resolved, "cursor");
  const reviewParam = single(resolved, "review");
  const status: ReviewStatus = reviewStatuses.find((value) => value === statusParam.value) ?? "pending";

  // DBクライアントは描画時に読み込む（ビルド時にDB接続情報を必要としない）。
  const { db } = await import("@/db/client");

  let selected: ProfileReview | "not_found" | null = null;
  if (reviewParam.value || reviewParam.malformed) {
    const reviewId = reviewParam.malformed ? null : uuid.safeParse(reviewParam.value);
    try {
      selected = reviewId?.success ? await loadProfileReview(db, viewer, reviewId.data) : "not_found";
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
      selected = "not_found";
    }
  }

  let result: ListResult;
  try {
    if (statusParam.malformed || cursorParam.malformed) throw new ApiError("BAD_REQUEST");
    const query = new URLSearchParams();
    if (statusParam.value) query.set("status", statusParam.value);
    if (cursorParam.value) query.set("cursor", cursorParam.value);
    const { data, page } = await listProfileReviews(db, viewer, parseProfileReviewQuery(new URL(`http://app/?${query}`)));
    result = { kind: "ok", items: data.items, page };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result = {
      kind: "invalid",
      message: error.code === "INVALID_CURSOR"
        ? "一覧の続きを表示できませんでした。最初のページから表示し直してください。"
        : "一覧の条件を確認してください。",
    };
  }
  const cursor = cursorParam.value || undefined;

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <p className={styles.area}>管理エリア</p>
          <h1 className={styles.title}>プロフィール再公開審査</h1>
          <p className={styles.lead}>非表示のプロフィールについて、本人が修正した内容を確認し、再公開を承認または却下します。</p>
        </header>

        {selected === "not_found" ? (
          <section className={styles.card} aria-label="選択した申請">
            <p className={styles.text} role="alert">この申請は表示できません。</p>
          </section>
        ) : null}
        {selected && selected !== "not_found" ? (
          <ReviewDetail key={selected.id} review={selected} closeHref={reviewsPath({ status, cursor })} />
        ) : null}

        <section className={styles.card} aria-labelledby="review-list-title">
          <h2 id="review-list-title" className={styles.sectionTitle}>
            申請の一覧{result.kind === "ok" ? <span className={styles.count}>{result.page.totalCount}件</span> : null}
          </h2>
          <nav aria-label="申請の状態">
            <ul className={styles.filters}>
              {reviewStatuses.map((value) => (
                <li key={value}>
                  <Link
                    className={styles.filter}
                    href={reviewsPath({ status: value })}
                    aria-current={value === status ? "page" : undefined}
                  >
                    {filterLabels[value]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {result.kind === "invalid" ? (
            <div className={styles.formError} role="alert">
              <p>{result.message}</p>
              <Link href={reviewsPath({ status })}>最初のページを表示する</Link>
            </div>
          ) : null}
          {result.kind === "ok" && result.items.length === 0 ? (
            result.page.totalCount > 0 ? (
              <p className={styles.text}>
                このページに表示できる申請はありません。<Link href={reviewsPath({ status })}>最初のページを表示する</Link>
              </p>
            ) : (
              <p className={styles.text}>{status === "pending" ? "審査待ちの申請はありません。" : "該当する申請はありません。"}</p>
            )
          ) : null}
          {result.kind === "ok" && result.items.length > 0 ? (
            <ul className={styles.list}>
              {result.items.map(({ review, displayName }) => (
                <li key={review.id} className={styles.listItem}>
                  <span className={statusBadges[review.status]}>{reviewStatusLabels[review.status]}</span>
                  <Link
                    className={styles.itemLink}
                    href={reviewsPath({ status, cursor, review: review.id })}
                    aria-current={selected && selected !== "not_found" && selected.id === review.id ? "true" : undefined}
                  >
                    {displayName}
                  </Link>
                  <span className={styles.meta}>申請日時：{formatDateTime(review.submittedAt)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {result.kind === "ok" && result.page.nextCursor ? (
            <p className={styles.links}>
              <Link href={reviewsPath({ status, cursor: result.page.nextCursor })}>次のページ</Link>
            </p>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
