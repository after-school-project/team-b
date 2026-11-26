"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { PageInfo } from "@/api/response";
import type {
  ManagedContent, ManagedNoticeListItem, NoticeContent, NoticeListItem, PublicNotice, RequestSummary, ReviewRequest,
} from "@/notices/notices";
import styles from "./notices.module.css";

type ApiEnvelope<T> = { data?: T; error?: { message?: string; fields?: { path: string; message: string }[] } };

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function errorText(body: ApiEnvelope<unknown>, status: number) {
  if (body.error?.message) return body.error.message;
  return status >= 500 ? "処理に失敗しました。時間をおいて再度お試しください。" : "入力内容を確認してください。";
}

function idempotencyKey() {
  return crypto.randomUUID();
}

export function NoticeSearchForm({ q, error }: { q: string; error?: string }) {
  return (
    <form className={styles.filters} action="/notices" method="get" role="search" aria-label="お知らせの検索条件">
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="notice-q">キーワード</label>
        <input id="notice-q" className={styles.input} name="q" defaultValue={q}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "notice-q-error notice-q-help" : "notice-q-help"} />
        {error ? <p id="notice-q-error" className={styles.fieldError}>{error}</p> : null}
        <p id="notice-q-help" className={styles.help}>公開中のお知らせのタイトルと本文から検索します。</p>
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryButton} type="submit">検索する</button>
        <Link className={styles.textButton} href="/notices">条件をクリア</Link>
      </div>
    </form>
  );
}

export function NoticeResults({
  items, page, filtered, continued, firstPageHref, nextPageHref,
}: {
  items: NoticeListItem[];
  page: PageInfo;
  filtered: boolean;
  continued: boolean;
  firstPageHref: string;
  nextPageHref: string | null;
}) {
  const changedWhilePaging = items.length === 0 && continued && page.totalCount > 0;
  return (
    <section className={styles.results} aria-labelledby="notice-results">
      <h2 id="notice-results" className={styles.sectionTitle}>お知らせ <span className={styles.count}>{page.totalCount}件</span></h2>
      {changedWhilePaging ? (
        <div className={styles.notice} role="status">
          <p>一覧が変わったため、この続きに表示できるお知らせはありません。最初のページから確認してください。</p>
        </div>
      ) : items.length === 0 ? (
        <p className={styles.empty}>{filtered ? "条件に合うお知らせはありません。" : "公開中のお知らせはありません。"}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li className={styles.item} key={item.id}>
              <p className={styles.badges}><span className={styles.badgeInfo}>{item.category.name}</span></p>
              <h3 className={styles.itemTitle}><Link href={`/notices/${item.id}`}>{item.title}</Link></h3>
              <p className={styles.meta}>
                {item.author.displayName}・初回公開{" "}
                <time dateTime={item.firstPublishedAt}>{formatDateTime(item.firstPublishedAt)}</time>
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

export function PublicNoticeDetail({ notice }: { notice: PublicNotice }) {
  return (
    <article className={styles.article}>
      <p className={styles.back}><Link href="/notices">お知らせ一覧へ戻る</Link></p>
      <p className={styles.badges}><span className={styles.badgeInfo}>{notice.category.name}</span></p>
      <h1 className={styles.title}>{notice.content.title}</h1>
      <p className={styles.meta}>
        {notice.author.displayName}・初回公開{" "}
        <time dateTime={notice.firstPublishedAt}>{formatDateTime(notice.firstPublishedAt)}</time>
      </p>
      <div className={styles.body}>{notice.content.body}</div>
    </article>
  );
}

export function NoticeForm({
  mode, initialContent, noticeId, requestId, expectedVersion,
}: {
  mode: "create" | "edit" | "resubmit";
  initialContent?: NoticeContent;
  noticeId?: string;
  requestId?: string;
  expectedVersion?: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialContent?.title ?? "");
  const [body, setBody] = useState(initialContent?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 保存されたか確認できない間は、同じ内容なら同じ再送キーで送り直す。
  const pending = useRef<{ body: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const content = { title, body, categoryCode: "general" };
    const path = mode === "create" ? "/api/v1/notices"
      : mode === "edit" ? `/api/v1/notices/${encodeURIComponent(noticeId ?? "")}/revisions`
        : `/api/v1/me/notice-requests/${encodeURIComponent(requestId ?? "")}/resubmission`;
    const payload = JSON.stringify(mode === "create" ? content : { expectedVersion, content });
    const key = pending.current?.body === payload ? pending.current.key : idempotencyKey();
    pending.current = { body: payload, key };
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: payload,
      });
      const result = await response.json() as ApiEnvelope<{ resource: { id: string }; state: string }>;
      pending.current = null;
      if (!response.ok || !result.data) {
        setError(errorText(result, response.status));
        return;
      }
      if (mode === "create") {
        // 審査が必要な新規投稿の結果は申請なので、本人一覧へ戻る。
        router.push(result.data.state === "public"
          ? `/notices/${encodeURIComponent(result.data.resource.id)}` : "/me/notices");
      } else if (mode === "edit") {
        router.push(`/me/notices?notice=${encodeURIComponent(noticeId ?? "")}`);
      } else {
        router.push(`/me/notices?notice=${encodeURIComponent(noticeId ?? "")}`
          + `&request=${encodeURIComponent(result.data.resource.id)}`);
      }
      router.refresh();
    } catch {
      setError("通信に失敗しました。入力内容を保持しています。");
    } finally {
      setSubmitting(false);
    }
  }

  const heading = mode === "create" ? "お知らせを作成" : mode === "edit" ? "お知らせを編集" : "修正して再申請";
  return (
    <form className={styles.form} onSubmit={submit}>
      <h1 className={styles.title}>{heading}</h1>
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="notice-title">タイトル</label>
        <input id="notice-title" className={styles.input} value={title} required
          aria-describedby="notice-title-help" onChange={(event) => setTitle(event.target.value)} />
        <p id="notice-title-help" className={styles.help}>100文字以内で入力してください。</p>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="notice-body">本文</label>
        <textarea id="notice-body" className={styles.textarea} value={body} required rows={14}
          aria-describedby="notice-body-help" onChange={(event) => setBody(event.target.value)} />
        <p id="notice-body-help" className={styles.help}>10,000文字以内のプレーンテキストで入力してください。</p>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>カテゴリー</span>
        <p className={styles.category}>お知らせ（仮）</p>
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryButton} type="submit" disabled={submitting}>
          {submitting ? "送信中…" : mode === "resubmit" ? "再申請する" : "保存する"}
        </button>
        <Link className={styles.textButton} href="/me/notices">キャンセル</Link>
      </div>
    </form>
  );
}

async function postJson<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey() },
    body: JSON.stringify(value),
  });
  const result = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !result.data) throw new Error(errorText(result, response.status));
  return result.data;
}

export function NoticeActions({ notice }: { notice: ManagedContent }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function withdraw(summary: RequestSummary) {
    setError(null);
    setBusy(true);
    try {
      await postJson(`/api/v1/me/notice-requests/${encodeURIComponent(summary.id)}/withdrawal`, {
        expectedVersion: summary.version,
      });
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取り下げに失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("このお知らせを削除します。削除後は一般に表示されず、180日後に本文を閲覧できなくなります。削除しますか？")) return;
    setError(null);
    setBusy(true);
    try {
      await postJson(`/api/v1/notices/${encodeURIComponent(notice.id)}/deletion`, {
        expectedVersion: notice.version, confirmed: true,
      });
      router.push("/me/notices");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  // 取り下げられるのは審査中の申請だけ。履歴で選択中の申請ではなく、審査中の申請を対象にする。
  const requestSummary = notice.pendingRequest;
  return (
    <div className={styles.actionsPanel}>
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      {notice.capabilities.canEdit ? (
        <Link className={styles.secondaryLink} href={`/me/notices/${notice.id}/edit`}>編集する</Link>
      ) : null}
      {requestSummary && notice.capabilities.canWithdraw ? (
        <button className={styles.textButton} disabled={busy} onClick={() => void withdraw(requestSummary)}>申請を取り下げる</button>
      ) : null}
      {notice.capabilities.canDelete ? (
        <button className={styles.dangerButton} disabled={busy} onClick={() => void remove()}>削除する</button>
      ) : null}
    </div>
  );
}

export function NoticeRequests({ items, selectedId, noticeId, nextPageHref }: {
  items: RequestSummary[];
  selectedId?: string;
  noticeId: string;
  nextPageHref?: string | null;
}) {
  if (!items.length) return <p className={styles.empty}>申請履歴はありません。</p>;
  return (
    <section className={styles.history} aria-labelledby="notice-history">
      <h3 id="notice-history">申請履歴</h3>
      <ol className={styles.historyList}>
        {items.map((item) => (
          <li key={item.id}>
            <Link aria-current={selectedId === item.id ? "page" : undefined}
              href={`/me/notices?notice=${encodeURIComponent(noticeId)}&request=${encodeURIComponent(item.id)}`}>
              {item.kind === "new" ? "新規申請" : "編集申請"}・{requestStatusLabel(item.status)}・
              <time dateTime={item.submittedAt}>{formatDateTime(item.submittedAt)}</time>
            </Link>
          </li>
        ))}
      </ol>
      {nextPageHref ? <p className={styles.pager}>
        <Link className={styles.secondaryLink} href={nextPageHref}>申請履歴の続きを表示</Link>
      </p> : null}
    </section>
  );
}

export function ManagedNoticeDetail({ notice }: { notice: ManagedContent }) {
  const content = notice.deletedContent ?? notice.publicContent;
  return (
    <section className={styles.managedDetail} aria-labelledby="managed-notice-title">
      <p className={styles.badges}>
        <span className={styles.badgeInfo}>{publicationLabel(notice.publicationState)}</span>
      </p>
      {content ? (
        <>
          <h2 id="managed-notice-title" className={styles.itemTitle}>{content.title}</h2>
          {notice.deletedAt ? (
            <p className={styles.meta}>
              削除日時 <time dateTime={notice.deletedAt}>{formatDateTime(notice.deletedAt)}</time>
              {notice.retentionExpiresAt ? <>・閲覧期限 <time dateTime={notice.retentionExpiresAt}>{formatDateTime(notice.retentionExpiresAt)}</time></> : null}
            </p>
          ) : null}
          <div className={styles.body}>{content.body}</div>
        </>
      ) : <p className={styles.empty}>表示できる本文はありません。</p>}
    </section>
  );
}

export function NoticeRequestDetail({ request }: { request: ReviewRequest }) {
  return (
    <section className={styles.requestDetail} aria-labelledby="notice-request-title">
      <h3 id="notice-request-title">{request.kind === "new" ? "新規申請" : "編集申請"}の内容</h3>
      <p className={styles.meta}>状態：{requestStatusLabel(request.status)}・申請日時{" "}
        <time dateTime={request.submittedAt}>{formatDateTime(request.submittedAt)}</time>
      </p>
      {request.decisionReason ? <p className={styles.notice}>却下理由：{request.decisionReason}</p> : null}
      {request.withdrawalReason ? <p className={styles.notice}>取り下げ理由：{request.withdrawalReason}</p> : null}
      <h4>{request.content.title}</h4>
      <div className={styles.body}>{request.content.body}</div>
    </section>
  );
}

export function MyNoticeResults({
  items, page, state, sort, cursor, selectedId,
}: {
  items: ManagedNoticeListItem[];
  page: PageInfo;
  state: string;
  sort: string;
  cursor?: string;
  selectedId?: string;
}) {
  const query = new URLSearchParams({ state, sort });
  const firstPageHref = `/me/notices?${query}`;
  if (page.nextCursor) query.set("cursor", page.nextCursor);
  const nextPageHref = page.nextCursor ? `/me/notices?${query}` : null;
  return (
    <section className={styles.results} aria-labelledby="my-notices">
      <h2 id="my-notices" className={styles.sectionTitle}>自分のお知らせ <span className={styles.count}>{page.totalCount}件</span></h2>
      {items.length === 0 ? <p className={styles.empty}>条件に合うお知らせはありません。</p> : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li className={styles.item} key={item.id}>
              <p className={styles.badges}>
                <span className={styles.badgeInfo}>{publicationLabel(item.publicationState)}</span>
                {item.pendingRequest ? <span className={styles.badgeWarning}>審査中</span> : null}
              </p>
              <h3 className={styles.itemTitle}>
                <Link aria-current={selectedId === item.id ? "page" : undefined}
                  href={`/me/notices?state=${encodeURIComponent(state)}&sort=${encodeURIComponent(sort)}&notice=${encodeURIComponent(item.id)}`}>
                  {item.title}
                </Link>
              </h3>
              <p className={styles.meta}>
                作成 <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>・更新{" "}
                <time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time>
                {item.latestRequestStatus ? `・最新申請：${requestStatusLabel(item.latestRequestStatus)}` : ""}
              </p>
              {item.capabilities.canEdit ? (
                <p><Link className={styles.secondaryLink} href={`/me/notices/${item.id}/edit`}>編集する</Link></p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor || nextPageHref ? (
        <p className={styles.pager}>
          {cursor ? <Link className={styles.secondaryLink} href={firstPageHref}>最初のページを表示</Link> : null}
          {nextPageHref ? <Link className={styles.secondaryLink} href={nextPageHref}>次の{page.limit}件を表示</Link> : null}
        </p>
      ) : null}
    </section>
  );
}

export function MyNoticeFilter({ state, sort }: { state: string; sort: string }) {
  return (
    <form className={styles.filters} action="/me/notices" method="get" aria-label="自分のお知らせの絞り込み">
      <div className={styles.selects}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-state">状態</label>
          <select className={styles.input} id="notice-state" name="state" defaultValue={state}>
            <option value="all">すべて</option>
            <option value="pending">審査中</option>
            <option value="public">公開済み</option>
            <option value="rejected">却下</option>
            <option value="withdrawn">取り下げ</option>
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
      </div>
      <button className={styles.primaryButton} type="submit">適用する</button>
    </form>
  );
}

function publicationLabel(state: ManagedContent["publicationState"] | ManagedNoticeListItem["publicationState"]) {
  switch (state) {
    case "public": return "公開中";
    case "hidden": return "管理者により非表示";
    case "deleted": return "削除済み";
    case "unpublished": return "未公開";
  }
}

function requestStatusLabel(status: RequestSummary["status"]) {
  switch (status) {
    case "pending": return "審査中";
    case "approved": return "承認";
    case "rejected": return "却下";
    case "withdrawn": return "取り下げ";
  }
}
