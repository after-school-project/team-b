"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { RestrictedMarkdown } from "@/components/markdown/RestrictedMarkdown";
import type { ResponseKind, ResponseView } from "@/qa/responses";
import { formatDateTime } from "../labels";
import pageStyles from "./page.module.css";
import styles from "./response-thread.module.css";

/**
 * 回答・コメント・返信のスレッドと投稿フォーム（QA-02、API-QA-07〜10）。
 *
 * - 一覧APIのフラットな配列を `parentResponseId` で木に組み立てる。親がまだ読み込まれていない投稿は先頭の階層に表示する。
 * - 操作の入口は、サーバーが返した `capabilities` で出し分ける。受付の可否は各APIで再認可する。
 * - 投稿・編集の後は、その投稿をAPI-QA-09で読み直して一覧へ反映する。読み込み済みの続きのページは保持する。
 */

const kindLabels: Record<ResponseKind, string> = { answer: "回答", comment: "コメント", reply: "返信" };

const bodyLimits: Record<ResponseKind, number> = { answer: 10_000, comment: 2_000, reply: 2_000 };
const pageLimit = 50;

type Page = { items: ResponseView[]; nextCursor: string | null };
type ApiBody<T> = {
  data?: T;
  error?: { code: string; fields?: { path: string; message: string }[] };
  meta?: { page?: { nextCursor: string | null } };
};

async function fetchResponse(responseId: string): Promise<ResponseView | null> {
  try {
    const response = await fetch(`/api/v1/responses/${encodeURIComponent(responseId)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body: ApiBody<ResponseView> | null = await response.json().catch(() => null);
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/** 返信先として、子の投稿に付ける操作の名前と種類。回答にはコメント、コメント・返信には返信を付ける。 */
function childOf(parent: ResponseView): { kind: ResponseKind; label: string } {
  return parent.kind === "answer" ? { kind: "comment", label: "コメントする" } : { kind: "reply", label: "返信する" };
}

type CreateTarget = { kind: ResponseKind; parentResponseId: string | null };

function ResponseForm({ questionId, create, edit, label, onSaved, onCancel, onReload }: {
  questionId: string;
  create?: CreateTarget;
  edit?: ResponseView;
  label: string;
  onSaved: (view: ResponseView | null, responseId: string) => void;
  onCancel?: () => void;
  onReload?: () => void;
}) {
  const kind = edit?.kind ?? create!.kind;
  const limit = bodyLimits[kind];
  const fieldId = `response-body-${edit?.id ?? `${create!.kind}-${create!.parentResponseId ?? "question"}`}`;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef<{ body: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    const formElement = event.currentTarget;
    const bodyMarkdown = String(new FormData(formElement).get("bodyMarkdown") ?? "");
    if (!bodyMarkdown.trim() || [...bodyMarkdown].length > limit) {
      setError(`本文は${limit.toLocaleString("ja-JP")}文字以内で入力してください。`);
      setNotice("入力内容を確認してください。");
      return;
    }

    const body = JSON.stringify(edit
      ? { expectedVersion: edit.version, bodyMarkdown }
      : { kind, parentResponseId: create!.parentResponseId, bodyMarkdown });
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    inFlight.current = true;
    setSending(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch(edit
        ? `/api/v1/responses/${encodeURIComponent(edit.id)}`
        : `/api/v1/questions/${encodeURIComponent(questionId)}/responses`, {
        method: edit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });
      const result: ApiBody<{ resource?: { type: string; id: string } }> | null = await response.json().catch(() => null);
      const resource = result?.data?.resource;
      if (response.ok && resource?.type === "response" && typeof resource.id === "string") {
        pending.current = null;
        if (!edit) formElement.reset();
        onSaved(await fetchResponse(resource.id), resource.id);
        return;
      }
      if (!result || response.ok || response.status >= 500) throw new Error("Save result unavailable");
      pending.current = null;
      const code = result.error?.code;
      if (response.status === 409 && code === "VERSION_CONFLICT") {
        setConflict(true);
        setNotice(`${kindLabels[kind]}が更新されています。入力内容を控えてから、最新の内容を読み込んでください。`);
      } else if (response.status === 409 && code === "STATE_CONFLICT") {
        setNotice("投稿先が削除または非表示になったため、投稿できません。画面を再読込して確認してください。");
      } else if (response.status === 422) {
        const fields = result.error?.fields ?? [];
        const bodyError = fields.find(({ path }) => path === "bodyMarkdown");
        if (bodyError) setError(bodyError.message || `本文は${limit.toLocaleString("ja-JP")}文字以内で入力してください。`);
        setNotice(fields.some(({ path }) => path === "parentResponseId")
          ? "投稿先が見つかりません。画面を再読込して確認してください。"
          : "入力内容を確認してください。");
      } else if (response.status === 403 && code === "PROFILE_WRITE_RESTRICTED") {
        setNotice("プロフィールが非表示のため、投稿・編集できません。");
      } else if ([401, 403, 404].includes(response.status)) {
        setNotice(`現在この${kindLabels[kind]}を保存できません。ログイン状態や投稿・編集の権限を確認してください。`);
      } else {
        setNotice(`${kindLabels[kind]}を保存できませんでした。時間をおいてもう一度お試しください。`);
      }
    } catch {
      setNotice("保存結果を確認できませんでした。内容を変えずにもう一度送信すると、同じ操作として確認できます。");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <form className={styles.form} method="post" onSubmit={submit} noValidate aria-busy={sending}>
      {notice ? <p className={styles.formError} role="alert">{notice}</p> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor={fieldId}>{label}</label>
        <textarea className={styles.textarea} id={fieldId} name="bodyMarkdown" required readOnly={sending}
          rows={kind === "answer" ? 8 : 4} defaultValue={edit?.content?.bodyMarkdown} aria-invalid={Boolean(error)}
          aria-describedby={error ? `${fieldId}-help ${fieldId}-error` : `${fieldId}-help`} />
        <p className={styles.help} id={`${fieldId}-help`}>
          {limit.toLocaleString("ja-JP")}文字以内。Markdownが使えます。HTML、脚注、HTTP・HTTPS以外のリンクは使えません。
          山かっこを文字として書くときはコード（`）で囲んでください。
        </p>
        {error ? <p className={styles.fieldError} id={`${fieldId}-error`}>{error}</p> : null}
      </div>
      <div className={styles.formActions}>
        <button className={styles.primaryButton} type="submit" disabled={sending || conflict}>
          {sending ? "送信中…" : edit ? "保存する" : "投稿する"}
        </button>
        {conflict && onReload ? <button className={styles.textButton} type="button" onClick={onReload}>
          最新の内容を読み込む
        </button> : null}
        {onCancel ? <button className={styles.textButton} type="button" onClick={onCancel} disabled={sending}>
          キャンセル
        </button> : null}
      </div>
    </form>
  );
}

type Open = { mode: "respond" | "edit"; id: string } | null;

function ResponseItem({ response, childrenOf, depth, questionId, open, setOpen, onSaved, onReload }: {
  response: ResponseView;
  childrenOf: (id: string) => ResponseView[];
  depth: number;
  questionId: string;
  open: Open;
  setOpen: Dispatch<SetStateAction<Open>>;
  onSaved: (view: ResponseView | null, responseId: string) => void;
  onReload: (responseId: string) => void;
}) {
  const children = childrenOf(response.id);
  const kind = kindLabels[response.kind];
  const child = childOf(response);
  const responding = open?.mode === "respond" && open.id === response.id;
  const editing = open?.mode === "edit" && open.id === response.id;
  // 保存したフォームだけを閉じる。保存を待つ間に別のフォームを開いていれば、そのフォームは開いたままにする。
  const savedFrom = (mode: "respond" | "edit") => (view: ResponseView | null, responseId: string) => {
    setOpen((current) => (current?.mode === mode && current.id === response.id ? null : current));
    onSaved(view, responseId);
  };

  return (
    <li className={styles.item}>
      {response.content === null ? (
        <article className={styles.withheld} id={`response-${response.id}`} tabIndex={-1} aria-label={kind}>
          <p className={styles.header}><span className={pageStyles.badgeNeutral}>
            {response.publicationState === "deleted" ? "削除済み" : "非表示"}
          </span></p>
          <p>{response.publicationState === "deleted"
            ? `この${kind}は削除されました。`
            : `この${kind}は現在表示できません。`}</p>
        </article>
      ) : (
        <article className={styles.card} id={`response-${response.id}`} tabIndex={-1}
          aria-label={`${response.author.displayName}さんの${kind}`}>
          <p className={styles.header}>
            <span className={response.kind === "answer" ? pageStyles.badgeInfo : pageStyles.badgeNeutral}>{kind}</span>
            {response.publicationState === "hidden" ? <span className={pageStyles.badgeNeutral}>非表示</span> : null}
            <span className={styles.meta}>
              <Link href={`/users/${encodeURIComponent(response.author.userId)}`}>{response.author.displayName}</Link>・
              <time dateTime={response.createdAt}>{formatDateTime(response.createdAt)}</time>
              {response.updatedAt !== response.createdAt ? "（編集済み）" : null}
            </span>
          </p>
          {response.publicationState === "hidden" ? <p className={styles.note}>
            この{kind}は管理者により非表示になっています。内容は本人と権限のある管理者だけに表示されます。
          </p> : null}
          {editing ? (
            <ResponseForm key={response.version} questionId={questionId} edit={response} label={`${kind}の本文`}
              onSaved={savedFrom("edit")} onCancel={() => setOpen(null)} onReload={() => onReload(response.id)} />
          ) : <RestrictedMarkdown source={response.content.bodyMarkdown} headingLevel={3} />}
          {!editing && (response.capabilities.canRespond || response.capabilities.canEdit) ? (
            <div className={styles.actions}>
              {response.capabilities.canRespond ? (
                <button className={styles.textButton} type="button" aria-expanded={responding}
                  onClick={() => setOpen(responding ? null : { mode: "respond", id: response.id })}>
                  {child.label}
                </button>
              ) : null}
              {response.capabilities.canEdit ? (
                <button className={styles.textButton} type="button"
                  onClick={() => setOpen({ mode: "edit", id: response.id })}>
                  {kind}を編集
                </button>
              ) : null}
            </div>
          ) : null}
          {responding ? (
            <ResponseForm questionId={questionId} create={{ kind: child.kind, parentResponseId: response.id }}
              label={`${kindLabels[child.kind]}の本文`} onSaved={savedFrom("respond")} onCancel={() => setOpen(null)} />
          ) : null}
        </article>
      )}
      {children.length ? (
        <ol className={depth >= 3 ? `${styles.children} ${styles.flat}` : styles.children}>
          {children.map((item) => (
            <ResponseItem key={item.id} response={item} childrenOf={childrenOf} depth={depth + 1} questionId={questionId}
              open={open} setOpen={setOpen} onSaved={onSaved} onReload={onReload} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function ResponseThread({ questionId, initial, canAnswer, unavailableReason }: {
  questionId: string;
  initial: Page;
  /** 質問に回答・直接のコメントを付けられるか（質問の `capabilities.canRespond`）。 */
  canAnswer: boolean;
  /** 回答できない理由の案内。表示しない場合は null。 */
  unavailableReason: string | null;
}) {
  // 一覧APIから読み込んだ投稿（投稿順）と、この画面で新しく投稿した投稿。新しい投稿は、まだ読み込んでいない
  // 続きのページの投稿よりも後に作られているため、読み込み済みの投稿の後ろに置く。続きのページに含まれていれば、
  // そのページの位置へ移す。
  const [pages, setPages] = useState(initial.items);
  const [added, setAdded] = useState<ResponseView[]>([]);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const [commenting, setCommenting] = useState(false);
  const focusId = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId.current) return;
    document.getElementById(`response-${focusId.current}`)?.focus();
    focusId.current = null;
  }, [pages, added]);

  const paged = new Set(pages.map(({ id }) => id));
  const items = [...pages, ...added.filter(({ id }) => !paged.has(id))];
  const loaded = new Set(items.map(({ id }) => id));
  const byParent = new Map<string | null, ResponseView[]>();
  for (const item of items) {
    const parent = item.parentResponseId !== null && loaded.has(item.parentResponseId) ? item.parentResponseId : null;
    byParent.set(parent, [...byParent.get(parent) ?? [], item]);
  }
  const childrenOf = (id: string) => byParent.get(id) ?? [];
  const roots = byParent.get(null) ?? [];

  /**
   * 1件の最新の内容を、表示中の位置のまま差し替える。読み込み済みのページにない投稿は、新しい投稿として末尾に加える。
   * 保存を待つ間に続きのページを読み込んでいてもよいよう、両方を更新し、重複は表示時に除く。
   */
  function replace(view: ResponseView) {
    setPages((current) => current.map((item) => (item.id === view.id ? view : item)));
    setAdded((current) => [...current.filter(({ id }) => id !== view.id), view]);
  }

  /** 続きのページを、読み込み済みの投稿の後ろに投稿順のまま加える。 */
  function appendPage(views: ResponseView[]) {
    const ids = new Set(views.map(({ id }) => id));
    setPages((current) => [...current.filter(({ id }) => !ids.has(id)), ...views]);
    setAdded((current) => current.filter(({ id }) => !ids.has(id)));
  }

  function saved(view: ResponseView | null, responseId: string) {
    const edited = loaded.has(responseId);
    if (view) {
      replace(view);
      setStatus(`${kindLabels[view.kind]}を${edited ? "保存" : "投稿"}しました。`);
      focusId.current = view.id;
    } else {
      setStatus(edited ? "保存しました。画面を再読込すると最新の内容を表示します。" : "投稿しました。画面を再読込すると表示されます。");
    }
  }

  async function reload(responseId: string) {
    const view = await fetchResponse(responseId);
    if (view) replace(view);
    else setLoadError("読み込めませんでした。もう一度お試しください。");
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ limit: String(pageLimit), cursor: nextCursor });
      const response = await fetch(`/api/v1/questions/${encodeURIComponent(questionId)}/responses?${query}`,
        { cache: "no-store" });
      const body: ApiBody<{ items: ResponseView[] }> | null = await response.json().catch(() => null);
      if (!response.ok || !body?.data) throw new Error("Load failed");
      appendPage(body.data.items);
      setNextCursor(body.meta?.page?.nextCursor ?? null);
    } catch {
      setLoadError("読み込めませんでした。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.thread}>
      <div role="status">{status ? <p className={styles.status}>{status}</p> : null}</div>
      {roots.length ? (
        <ol className={styles.list}>
          {roots.map((item) => (
            <ResponseItem key={item.id} response={item} childrenOf={childrenOf} depth={0} questionId={questionId}
              open={open} setOpen={setOpen} onSaved={saved} onReload={reload} />
          ))}
        </ol>
      ) : <p className={styles.empty}>まだ回答・コメントはありません。</p>}
      {loadError ? <p className={styles.formError} role="alert">{loadError}</p> : null}
      {nextCursor ? (
        <p><button className={styles.textButton} type="button" onClick={loadMore} disabled={loading}>
          {loading ? "読み込み中…" : "さらに表示"}
        </button></p>
      ) : null}
      {canAnswer ? (
        <>
          <section className={styles.formCard} aria-labelledby="answer-form-title">
            <h3 className={styles.sectionTitle} id="answer-form-title">回答を投稿</h3>
            <ResponseForm questionId={questionId} create={{ kind: "answer", parentResponseId: null }}
              label="回答の本文" onSaved={saved} />
          </section>
          {commenting ? (
            <section className={styles.formCard} aria-labelledby="comment-form-title">
              <h3 className={styles.sectionTitle} id="comment-form-title">質問にコメント</h3>
              <ResponseForm questionId={questionId} create={{ kind: "comment", parentResponseId: null }}
                label="コメントの本文" onSaved={(view, responseId) => {
                  setCommenting(false);
                  saved(view, responseId);
                }} onCancel={() => setCommenting(false)} />
            </section>
          ) : (
            <p><button className={styles.textButton} type="button" aria-expanded={false}
              onClick={() => setCommenting(true)}>質問にコメントする</button></p>
          )}
        </>
      ) : unavailableReason ? <p className={styles.note}>{unavailableReason}</p> : null}
    </div>
  );
}
