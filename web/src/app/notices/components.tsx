import Link from "next/link";
import type { ReactNode } from "react";
import type { PageInfo } from "@/api/response";
import type {
  ManagedContent, ManagedNoticeListItem, NoticeListItem, PublicNotice, RequestSummary, ReviewRequest,
} from "@/notices/notices";
import { ConfirmNoticeAction } from "./notice-forms";
import { myNoticeHref } from "./notice-links";
import styles from "./notices.module.css";

const dateOnly = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric",
});
const dateAndTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
});

function NoticeDate({ value, detailed = false }: { value: string; detailed?: boolean }) {
  return <time dateTime={value}>{(detailed ? dateAndTime : dateOnly).format(new Date(value))}</time>;
}

const publication = {
  public: { text: "公開中", tone: "success" },
  hidden: { text: "管理者により非表示", tone: "warning" },
  deleted: { text: "削除済み", tone: "neutral" },
  unpublished: { text: "未公開", tone: "neutral" },
};

const review = {
  pending: { text: "審査中", tone: "warning" },
  approved: { text: "承認済み", tone: "success" },
  rejected: { text: "却下", tone: "danger" },
  withdrawn: { text: "取り下げ済み", tone: "neutral" },
};

const requestKind = { new: "新規申請", edit: "編集申請" };

function Badge({ text, tone }: { text: string; tone: string }) {
  return <span className={styles.badge} data-tone={tone}>{text}</span>;
}

function Origin({ kind }: { kind: NoticeListItem["originKind"] }) {
  return <Badge text={kind === "school" ? "学校公式" : "卒業生"} tone="info" />;
}

export function NoticeSectionNav({ current }: { current: "public" | "mine" }) {
  return (
    <nav className={styles.sectionNav} aria-label="お知らせのメニュー">
      <Link href="/notices" aria-current={current === "public" ? "page" : undefined}>公開のお知らせ</Link>
      <Link href="/me/notices" aria-current={current === "mine" ? "page" : undefined}>自分のお知らせ</Link>
    </nav>
  );
}

export function NoticeBreadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className={styles.breadcrumbs} aria-label="パンくず">
      <ol>
        {items.map(({ label, href }, index) => (
          <li key={index}>{href ? <Link href={href}>{label}</Link> : <span aria-current="page">{label}</span>}</li>
        ))}
      </ol>
    </nav>
  );
}

export function NoticeSearchForm({ q, error }: { q: string; error?: string }) {
  return (
    <form className={styles.filters} action="/notices" method="get" role="search" aria-label="お知らせを検索">
      <div className={styles.filterRow}>
        <div className={styles.searchField}>
          <label className={styles.label} htmlFor="notice-q">キーワード</label>
          <input id="notice-q" type="search" className={styles.input} name="q" defaultValue={q}
            placeholder="タイトル・本文から検索"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "notice-q-error" : undefined} />
        </div>
        <button className={styles.primaryButton} type="submit">検索</button>
        {q ? <Link className={styles.textButton} href="/notices">クリア</Link> : null}
      </div>
      {error ? <p id="notice-q-error" className={styles.formError} role="alert">{error}</p> : null}
    </form>
  );
}

function NoticePager({ firstHref, nextHref, children }: {
  firstHref?: string; nextHref?: string | null; children: ReactNode;
}) {
  if (!firstHref && !nextHref) return null;
  return (
    <nav className={styles.pager} aria-label="ページ送り">
      {firstHref ? <Link className={styles.secondaryButton} href={firstHref}>最初のページ</Link> : null}
      {nextHref ? <Link className={styles.secondaryButton} href={nextHref}>{children}</Link> : null}
    </nav>
  );
}

export function NoticeResults({ items, page, filtered, continued, firstPageHref, nextPageHref, search }: {
  items: NoticeListItem[]; page: PageInfo; filtered: boolean; continued: boolean;
  firstPageHref: string; nextPageHref: string | null; search?: string;
}) {
  const changedWhilePaging = items.length === 0 && continued && page.totalCount > 0;
  return (
    <section className={styles.results} aria-label={filtered ? "検索結果" : "公開のお知らせ一覧"}>
      <p className={styles.resultsCount}>{filtered ? "検索結果 " : ""}<strong>{page.totalCount}件</strong></p>
      {items.length === 0 ? (
        <p className={styles.empty}>{changedWhilePaging ? "一覧が更新されました。最初のページから確認してください。"
          : filtered ? "条件に合うお知らせはありません。" : "公開中のお知らせはありません。"}</p>
      ) : (
        <ul className={styles.rows}>
          {items.map((item) => (
            <li key={item.id}>
              <Link className={styles.rowLink} href={`/notices/${item.id}${search ? `?${search}` : ""}`}>
                <div className={styles.rowMain}>
                  <div className={styles.badges}><Origin kind={item.originKind} /></div>
                  <h2 className={styles.itemTitle}>{item.title}</h2>
                  <p className={styles.meta}>{item.author.displayName}</p>
                </div>
                <p className={styles.rowDate}><NoticeDate value={item.firstPublishedAt} /></p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NoticePager firstHref={continued ? firstPageHref : undefined} nextHref={nextPageHref}>
        次の{page.limit}件を表示
      </NoticePager>
    </section>
  );
}

export function PublicNoticeDetail({ notice }: { notice: PublicNotice }) {
  return (
    <article className={styles.readingArticle}>
      <header className={styles.articleHeader}>
        <div className={styles.badges}><Origin kind={notice.originKind} /><Badge text={notice.category.name} tone="neutral" /></div>
        <h1 className={styles.title}>{notice.content.title}</h1>
        <p className={styles.meta}>
          {notice.author.displayName === "非公開ユーザー" ? notice.author.displayName
            : <Link href={`/users/${encodeURIComponent(notice.author.userId)}`}>{notice.author.displayName}</Link>}
          {" · "}
          <NoticeDate value={notice.firstPublishedAt} />
        </p>
      </header>
      <div className={styles.body}>{notice.content.body}</div>
    </article>
  );
}

export function MyNoticeFilter({ state, sort }: { state: string; sort: string }) {
  return (
    <form className={styles.filters} action="/me/notices" method="get" aria-label="自分のお知らせの絞り込み">
      <div className={styles.filterRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-state">状態</label>
          <select className={styles.input} id="notice-state" name="state" defaultValue={state}>
            <option value="all">すべて</option>
            <option value="public">公開中</option>
            <option value="pending">審査中</option>
            <option value="rejected">却下</option>
            <option value="withdrawn">取り下げ済み</option>
            <option value="deleted">削除済み</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-sort">並び順</label>
          <select className={styles.input} id="notice-sort" name="sort" defaultValue={sort}>
            <option value="created_desc">作成日時の新しい順</option>
            <option value="updated_desc">更新日時の新しい順</option>
          </select>
        </div>
        <button className={styles.secondaryButton} type="submit">適用</button>
      </div>
    </form>
  );
}

export function MyNoticeResults({ items, page, position }: {
  items: ManagedNoticeListItem[]; page: PageInfo; position: URLSearchParams;
}) {
  const firstPage = new URLSearchParams(position);
  firstPage.delete("cursor");
  const nextPage = new URLSearchParams(firstPage);
  if (page.nextCursor) nextPage.set("cursor", page.nextCursor);
  const sortByUpdated = position.get("sort") === "updated_desc";
  return (
    <section className={styles.results} aria-label="自分のお知らせ一覧">
      <p className={styles.resultsCount}><strong>{page.totalCount}件</strong></p>
      {items.length === 0 ? <p className={styles.empty}>条件に合うお知らせはありません。</p> : (
        <ul className={styles.rows}>
          {items.map((item) => (
            <li key={item.id}>
              <Link className={styles.rowLink} href={myNoticeHref({ noticeId: item.id }, position)}>
                <div className={styles.rowMain}>
                  <div className={styles.badges}>
                    <Badge {...publication[item.publicationState]} />
                    {item.publicationState !== "deleted" && item.latestRequestStatus ? <Badge {...review[item.latestRequestStatus]} /> : null}
                  </div>
                  <h2 className={styles.itemTitle}>{item.title}</h2>
                </div>
                <p className={styles.rowDate}>{sortByUpdated ? "更新" : "作成"} <NoticeDate value={sortByUpdated ? item.updatedAt : item.createdAt} /></p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NoticePager firstHref={position.has("cursor") ? myNoticeHref({}, firstPage) : undefined}
        nextHref={page.nextCursor ? myNoticeHref({}, nextPage) : null}>
        次の{page.limit}件を表示
      </NoticePager>
    </section>
  );
}

export function ManagedNoticeHeader({ notice, editHref }: { notice: ManagedContent; editHref: string }) {
  const title = (notice.deletedContent ?? notice.publicContent)?.title ?? "お知らせ";
  return (
    <header className={styles.pageHeading}>
      <div className={styles.header}>
        <div className={styles.badges}><Origin kind={notice.originKind} /><Badge {...publication[notice.publicationState]} /></div>
        <h1 className={styles.title}>{title}</h1>
      </div>
      <div className={styles.actions}>
        <a className={`${styles.secondaryButton} ${styles.historyJump}`} href="#notice-history">申請履歴へ</a>
        {notice.publicationState === "public" ? (
          <Link className={styles.secondaryButton} href={`/notices/${notice.id}`}>公開版を見る</Link>
        ) : null}
        {notice.capabilities.canEdit ? <Link className={styles.primaryButton} href={editHref}>編集する</Link> : null}
      </div>
    </header>
  );
}

export function ManagedNoticeDetail({ notice }: { notice: ManagedContent }) {
  const content = notice.deletedContent ?? notice.publicContent;
  const bodyLabel = notice.publicationState === "public" ? "公開中の本文"
    : notice.publicationState === "unpublished" ? "未公開の本文" : "本文";
  return (
    <section className={styles.panel} aria-labelledby="notice-body-heading">
      <header className={styles.articleHeader}>
        <h2 className={styles.sectionTitle} id="notice-body-heading">{bodyLabel}</h2>
        {notice.publicationState === "hidden" ? <p className={styles.meta}>管理者により非表示</p> : null}
        {notice.deletedAt ? <p className={styles.meta}>
          削除日 <NoticeDate value={notice.deletedAt} />
          {notice.retentionExpiresAt ? <> · 閲覧期限 <NoticeDate value={notice.retentionExpiresAt} detailed /></> : null}
        </p> : null}
      </header>
      <div className={styles.body}>{content?.body ?? "表示できる本文はありません。"}</div>
    </section>
  );
}

export function NoticeRequests({ items, noticeId, nextPageHref, firstPageHref, historyError, position, requestCursor }: {
  items: RequestSummary[]; noticeId: string; nextPageHref?: string | null; firstPageHref?: string;
  historyError?: boolean; position?: URLSearchParams; requestCursor?: string;
}) {
  return (
    <section className={styles.history} aria-labelledby="notice-history">
      <h2 className={styles.sectionTitle} id="notice-history" tabIndex={-1}>申請履歴</h2>
      {historyError ? (
        <p className={styles.formError} role="alert">履歴の続きを表示できませんでした。最初のページから確認してください。</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>申請履歴はありません。</p>
      ) : (
        <ol className={styles.historyList}>
          {items.map((item) => (
            <li key={item.id}>
              <Link className={styles.historyLink} href={myNoticeHref({ noticeId, requestId: item.id, requestCursor }, position)}>
                <div className={styles.historyMain}>
                  <strong>{requestKind[item.kind]}</strong>
                  <Badge {...review[item.status]} />
                </div>
                <p className={styles.meta}>受付 <NoticeDate value={item.submittedAt} detailed /></p>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <NoticePager firstHref={firstPageHref} nextHref={nextPageHref}>申請履歴の続きを表示</NoticePager>
    </section>
  );
}

export function NoticeRequestDetail({ request, resubmitHref }: { request: ReviewRequest; resubmitHref: string }) {
  return (
    <>
      <header className={styles.header}>
        <div className={styles.badges}><Badge {...review[request.status]} /></div>
        <h1 className={styles.title}>{requestKind[request.kind]}</h1>
      </header>
      <div className={styles.detailGrid}>
        <article className={styles.panel}>
          <header className={styles.articleHeader}>
            <h2 className={styles.sectionTitle}>{request.content.title}</h2>
          </header>
          <div className={styles.body}>{request.content.body}</div>
        </article>
        <section className={styles.requestSummary} aria-labelledby="review-summary">
          <h2 className={styles.sectionTitle} id="review-summary">審査状況</h2>
          <dl className={styles.summaryList}>
            <div><dt>申請日時</dt><dd><NoticeDate value={request.submittedAt} detailed /></dd></div>
            {request.decidedAt ? <div><dt>審査日時</dt><dd><NoticeDate value={request.decidedAt} detailed /></dd></div> : null}
            {request.decisionReason ? <div><dt>却下理由</dt><dd className={styles.preserveLines}>{request.decisionReason}</dd></div> : null}
            {request.withdrawalReason ? <div><dt>取り下げ理由</dt><dd className={styles.preserveLines}>{request.withdrawalReason}</dd></div> : null}
          </dl>
          {request.status === "pending" ? (
            <p className={styles.lead}>{request.kind === "edit"
              ? "編集内容は承認後に公開版に反映されます。"
              : "承認されるまでこのお知らせは公開されません。"}</p>
          ) : null}
          {request.capabilities.canResubmit ? <Link className={styles.primaryButton} href={resubmitHref}>修正して再申請</Link> : null}
          {request.capabilities.canWithdraw ? (
            <ConfirmNoticeAction key={request.id} operation="withdraw" subject={request.content.title} target={request.id} version={request.version} />
          ) : null}
        </section>
      </div>
    </>
  );
}
