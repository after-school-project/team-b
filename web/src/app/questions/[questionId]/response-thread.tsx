"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { noCapabilities } from "@/auth/capabilities";
import { VisibilityAction } from "./visibility-action";
import { RestrictedMarkdown } from "@/components/markdown/RestrictedMarkdown";
import type { ResponseKind, ResponseView } from "@/qa/responses";
import { formatDateTime } from "../labels";
import { DeleteConfirm } from "./delete-confirm";
import pageStyles from "./page.module.css";
import styles from "./response-thread.module.css";

/**
 * 回答・コメント・返信のスレッドと投稿・削除の操作（QA-02、API-QA-07〜11）。
 *
 * - 一覧APIのフラットな配列を `parentResponseId` で木に組み立てる。親がまだ読み込まれていない投稿は先頭の階層に表示する。
 * - 操作の入口は、サーバーが返した `capabilities` で出し分ける。受付の可否は各APIで再認可する。
 * - 投稿・編集の後は、その投稿をAPI-QA-09で読み直して一覧へ反映する。削除の後は、読み直さずに削除済みの状態案内へ差し替える。
 *   読み込み済みの続きのページは保持する。
 * - 削除しても子の投稿は残る（API-QA-11）。削除した投稿は状態案内に変わり、子はその下に表示したままにする。
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

/**
 * 同じ投稿の2つの内容のうち、新しいほう。版番号は編集のたびに増えるため、両方に版番号があれば大きいほうを使う。
 * 削除・非表示で版番号のない状態案内になった応答は、版番号で比べられないため、届いた内容を使う。
 */
function newer(shown: ResponseView, incoming: ResponseView): ResponseView {
  // 削除は元に戻せないため、削除済みと分かった投稿は、遅れて届いた削除前の応答で上書きしない。
  if (shown.publicationState === "deleted") return shown;
  return shown.version !== null && incoming.version !== null && shown.version > incoming.version ? shown : incoming;
}

type CreateTarget ={ kind: ResponseKind; parentResponseId: string | null };

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

/** 開いている投稿のフォーム。`token` はフォームを開くたびに変わり、閉じて開き直したフォームを別のものとして区別する。 */
type Open = { mode: "respond" | "edit"; id: string; token: number } | null;

type FormControls = {
  open: Open;
  openForm: (mode: "respond" | "edit", id: string) => void;
  /** 指定したフォームが今も開いていれば閉じる。省略すると、開いているフォームを閉じる。 */
  closeForm: (token?: number) => void;
};

/** 削除の確認に示す本文の冒頭。改行をまとめ、長い本文は省略する。 */
function excerpt(markdown: string): string {
  const text = markdown.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : text;
}

function ResponseItem({ response, childrenOf, depth, questionId, forms, onSaved, onReload, onDeleted }: {
  response: ResponseView;
  childrenOf: (id: string) => ResponseView[];
  depth: number;
  questionId: string;
  forms: FormControls;
  onSaved: (view: ResponseView | null, responseId: string) => void;
  onReload: (responseId: string) => Promise<boolean>;
  onDeleted: (response: ResponseView) => void;
}) {
  const { open, openForm, closeForm } = forms;
  const children = childrenOf(response.id);
  const kind = kindLabels[response.kind];
  const child = childOf(response);
  const responding = open?.mode === "respond" && open.id === response.id;
  const editing = open?.mode === "edit" && open.id === response.id;
  // 保存したフォームだけを閉じる。保存を待つ間に閉じて開き直したフォームや、別のフォームは開いたままにする。
  const savedFrom = (token: number) => (view: ResponseView | null, responseId: string) => {
    closeForm(token);
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
            <ResponseForm key={`${open.token}:${response.version}`} questionId={questionId} edit={response}
              label={`${kind}の本文`} onSaved={savedFrom(open.token)} onCancel={() => closeForm(open.token)}
              onReload={() => onReload(response.id)} />
          ) : <RestrictedMarkdown source={response.content.bodyMarkdown} headingLevel={3} />}
          {!editing && (response.capabilities.canRespond || response.capabilities.canEdit
            || response.capabilities.canDelete || response.capabilities.canHide || response.capabilities.canRestore) ? (
            <div className={styles.actions}>
              {response.capabilities.canRespond ? (
                <button className={styles.textButton} type="button" aria-expanded={responding}
                  onClick={() => (responding ? closeForm() : openForm("respond", response.id))}>
                  {child.label}
                </button>
              ) : null}
              {response.capabilities.canEdit ? (
                <button className={styles.textButton} type="button" onClick={() => openForm("edit", response.id)}>
                  {kind}を編集
                </button>
              ) : null}
              {response.capabilities.canDelete && response.version !== null ? (
                <DeleteConfirm target="response" id={response.id} version={response.version} label={`${kind}を削除`}
                  subject={excerpt(response.content.bodyMarkdown)}
                  description={`削除すると、この${kind}の本文は表示されなくなり、元に戻せません。${
                    response.kind === "answer" ? "この回答へのコメント・返信" : `この${kind}への返信`
                  }は削除されず、そのまま表示されます。`}
                  onDeleted={() => onDeleted(response)} />
              ) : null}
              {response.capabilities.canHide || response.capabilities.canRestore ? (
                <VisibilityAction target="response" id={response.id} kind={kind} version={response.version}
                  visibility={response.capabilities.canHide ? "hidden" : "public"}
                  onChanged={() => onReload(response.id)} />
              ) : null}
            </div>
          ) : null}
          {responding && response.capabilities.canRespond ? (
            <ResponseForm key={open.token} questionId={questionId}
              create={{ kind: child.kind, parentResponseId: response.id }} label={`${kindLabels[child.kind]}の本文`}
              onSaved={savedFrom(open.token)} onCancel={() => closeForm(open.token)} />
          ) : null}
        </article>
      )}
      {children.length ? (
        <ol className={depth >= 3 ? `${styles.children} ${styles.flat}` : styles.children}>
          {children.map((item) => (
            <ResponseItem key={item.id} response={item} childrenOf={childrenOf} depth={depth + 1} questionId={questionId}
              forms={forms} onSaved={onSaved} onReload={onReload} onDeleted={onDeleted} />
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
  // `pages` は一覧APIから読み込んだ投稿（投稿順）、`added` はこの画面で新しく投稿した投稿（投稿した順）。
  // 新しい投稿は、まだ読み込んでいない続きのページの投稿よりも後に作られているため、読み込み済みの投稿の後ろに置く。
  // 続きのページに含まれていれば、そのページの位置へ移す。両方を同時に更新するため、1つの状態にまとめる。
  const [thread, setThread] = useState<{ pages: ResponseView[]; added: ResponseView[] }>({
    pages: initial.items, added: [],
  });
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const [commenting, setCommenting] = useState(false);
  const focusId = useRef<string | null>(null);
  const formToken = useRef(0);
  // 画面で反映した投稿ごとの反映の順番。取得を始めた後に反映した内容を、遅れて届いた一覧で巻き戻さないために使う。
  const sequence = useRef(0);
  const replacedAt = useRef(new Map<string, number>());

  useEffect(() => {
    if (!focusId.current) return;
    document.getElementById(`response-${focusId.current}`)?.focus();
    focusId.current = null;
  }, [thread]);

  // GE-05 などから開いた投稿（`#response-{id}`）が最初のページにないときは、API-QA-09 で読み込んで加え、フォーカスを移す。
  // 画面の再取得（質問の削除など）で `initial` が変わっても繰り返さないよう、最初の表示で1回だけ行う。
  const anchorHandled = useRef(false);
  useEffect(() => {
    if (anchorHandled.current) return;
    anchorHandled.current = true;
    const match = /^#response-([0-9a-f-]{36})$/i.exec(window.location.hash);
    const responseId = match?.[1].toLowerCase();
    if (!responseId || initial.items.some(({ id }) => id === responseId)) return;
    // 取得を待つ間に利用者がフォーカスを移した（回答欄に入力し始めたなど）場合は、投稿を表示するだけにする。
    const focusedAtStart = document.activeElement;
    void fetchResponse(responseId).then((view) => {
      if (!view || view.questionId !== questionId) return;
      if (document.activeElement === focusedAtStart) focusId.current = view.id;
      replace(view);
    });
  });

  const forms: FormControls = {
    open,
    openForm: (mode, id) => setOpen({ mode, id, token: ++formToken.current }),
    closeForm: (token) => setOpen((current) => (token === undefined || current?.token === token ? null : current)),
  };

  const { pages, added } = thread;
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
   * 1件の最新の内容を、表示中の位置のまま差し替える。表示していない投稿は、新しい投稿として末尾に加える。
   * 個別取得の応答は届く順が前後するため、表示中より古い版の応答では差し替えない。
   */
  function replace(view: ResponseView) {
    replacedAt.current.set(view.id, ++sequence.current);
    setThread((current) => {
      const swap = (items: ResponseView[]) => items.map((item) => (item.id === view.id ? newer(item, view) : item));
      if (current.pages.some(({ id }) => id === view.id)) return { ...current, pages: swap(current.pages) };
      if (current.added.some(({ id }) => id === view.id)) return { ...current, added: swap(current.added) };
      return { ...current, added: [...current.added, view] };
    });
  }

  /**
   * 続きのページを、読み込み済みの投稿の後ろに投稿順のまま加える。表示中の投稿は一覧の位置へ移し、内容は版番号の新しいほうを
   * 使う。版番号で比べられない場合は、取得を始めた後（`startedAt` より後）に画面で反映した内容を保つ。
   */
  function appendPage(views: ResponseView[], startedAt: number) {
    setThread((current) => {
      const shown = new Map([...current.pages, ...current.added].map((item) => [item.id, item]));
      const ids = new Set(views.map(({ id }) => id));
      const page = views.map((view) => {
        const item = shown.get(view.id);
        if (!item) return view;
        // 削除済みの投稿は、取得を始めた時点にかかわらず削除済みのままにする（`newer` と同じ）。
        // 両方に版番号があれば、届いた順にかかわらず新しい版を使う。版番号のない状態案内では比べられないため、
        // 取得を始めた後に画面で反映した内容を残す。
        if (item.publicationState === "deleted" || (item.version !== null && view.version !== null)) {
          return newer(item, view);
        }
        return (replacedAt.current.get(view.id) ?? 0) > startedAt ? item : view;
      });
      return {
        pages: [...current.pages.filter(({ id }) => !ids.has(id)), ...page],
        added: current.added.filter(({ id }) => !ids.has(id)),
      };
    });
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

  /**
   * 削除した投稿を、削除済みの状態案内に差し替える。子の投稿は残るため、スレッドの位置はそのまま。
   * 削除済みの投稿は、だれが取得しても本文・著者・版番号のない同じ形になる（API-QA-09）ため、読み直さずに画面で作る。
   * 読み直しの失敗で成功の通知やフォーカスの移動が抜けないよう、差し替えと同時に行う。
   */
  function deleted(response: ResponseView) {
    // 削除した投稿に開いていたフォームだけを閉じる。ほかの投稿のフォームと下書きはそのまま残す。
    setOpen((current) => (current?.id === response.id ? null : current));
    focusId.current = response.id;
    replace({
      ...response, publicationState: "deleted", content: null, author: null, version: null, createdAt: null,
      updatedAt: null, capabilities: { ...noCapabilities },
    });
    setStatus(`${kindLabels[response.kind]}を削除しました。`);
  }

  async function reload(responseId: string) {
    const view = await fetchResponse(responseId);
    if (!view) {
      setLoadError("読み込めませんでした。もう一度お試しください。");
      return false;
    }
    if (!view.capabilities.canRespond) {
      setOpen((current) => current?.mode === "respond" && current.id === responseId ? null : current);
    }
    replace(view);
    return true;
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    setLoadError("");
    const startedAt = sequence.current;
    try {
      const query = new URLSearchParams({ limit: String(pageLimit), cursor: nextCursor });
      const response = await fetch(`/api/v1/questions/${encodeURIComponent(questionId)}/responses?${query}`,
        { cache: "no-store" });
      const body: ApiBody<{ items: ResponseView[] }> | null = await response.json().catch(() => null);
      if (!response.ok || !body?.data) throw new Error("Load failed");
      appendPage(body.data.items, startedAt);
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
              forms={forms} onSaved={saved} onReload={reload} onDeleted={deleted} />
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
