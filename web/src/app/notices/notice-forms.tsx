"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { NoticeContent } from "@/notices/notices";
import { NOTICE_CATEGORY } from "@/notices/category";
import { myNoticeHref } from "./notice-links";
import styles from "./notices.module.css";

type ApiEnvelope<T> = { data?: T; error?: { message?: string } };
type PendingMutation = { path: string; body: string; key: string };
type MutationResult = { resource: { type: "notice" | "notice_request"; id: string }; state: string };

async function sendMutation<T>(
  path: string,
  value: unknown,
  pending: { current: PendingMutation | null },
): Promise<T> {
  const body = JSON.stringify(value);
  const previous = pending.current;
  const key = previous?.path === path && previous.body === body ? previous.key : crypto.randomUUID();
  pending.current = { path, body, key };
  let result: ApiEnvelope<T>;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body,
    });
    result = await response.json();
  } catch {
    throw new Error("通信に失敗しました。時間をおいて再試行してください。");
  }
  if (!response.ok || !result.data) {
    throw new Error(result.error?.message ?? "処理に失敗しました。時間をおいて再試行してください。");
  }
  return result.data;
}

const formLabels = {
  create: "お知らせを作成",
  edit: "お知らせを編集",
  resubmit: "修正して再申請",
};

const submissionLabels = {
  publish: { label: "公開する", description: "保存すると、利用者に公開されます。" },
  review: { label: "審査に提出する", description: "承認されると公開されます。" },
  hidden: { label: "編集を保存する", description: "保存後も管理者による非表示は続きます。" },
};

type FormProps = { cancelHref: string; listSearch?: string } & (
  | { mode: "create"; submission: "publish" | "review" }
  | { mode: "edit"; submission: keyof typeof submissionLabels; noticeId: string; expectedVersion: number; initialContent: NoticeContent }
  | { mode: "resubmit"; submission: "review"; noticeId: string; requestId: string; expectedVersion: number; initialContent: NoticeContent }
);

export function NoticeForm(props: FormProps) {
  const router = useRouter();
  const { mode, submission, cancelHref } = props;
  const initialContent = mode === "create" ? undefined : props.initialContent;
  const [title, setTitle] = useState(initialContent?.title ?? "");
  const [body, setBody] = useState(initialContent?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptedRequest, setAcceptedRequest] = useState<string | null>(null);
  const pending = useRef<PendingMutation | null>(null);

  async function openNewRequest(id: string, position: URLSearchParams) {
    try {
      const response = await fetch(`/api/v1/me/notice-requests/${encodeURIComponent(id)}`, { cache: "no-store" });
      const result = await response.json() as ApiEnvelope<{ resourceId: string }>;
      if (!response.ok || !result.data) throw new Error();
      return myNoticeHref({ noticeId: result.data.resourceId, requestId: id }, position);
    } catch {
      throw new Error("申請は受け付けました。詳細を開けなかったため、もう一度お試しください。");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const position = new URLSearchParams(props.listSearch);
      if (acceptedRequest) {
        router.replace(await openNewRequest(acceptedRequest, position));
        router.refresh();
        return;
      }
      if ([...title.trim()].length > 100) throw new Error("タイトルは100文字以内で入力してください。");
      if ([...body].length > 10000) throw new Error("本文は10,000文字以内で入力してください。");
      const content = { title, body, categoryCode: NOTICE_CATEGORY.code };
      const path = mode === "create" ? "/api/v1/notices"
        : mode === "edit" ? `/api/v1/notices/${encodeURIComponent(props.noticeId)}/revisions`
          : `/api/v1/me/notice-requests/${encodeURIComponent(props.requestId)}/resubmission`;
      const result = await sendMutation<MutationResult>(path, mode === "create" ? content : {
        expectedVersion: props.expectedVersion, content,
      }, pending);
      let destination: string;
      if (result.resource.type === "notice_request") {
        const id = result.resource.id;
        if (mode === "create") {
          setAcceptedRequest(id);
          destination = await openNewRequest(id, position);
        } else {
          destination = myNoticeHref({ noticeId: props.noticeId, requestId: id }, position);
        }
      } else {
        destination = result.state === "public"
          ? `/notices/${encodeURIComponent(result.resource.id)}`
          : myNoticeHref({ noticeId: result.resource.id }, position);
      }
      router.replace(destination);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "処理に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  const { label, description } = submissionLabels[submission];
  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>{formLabels[mode]}</h1>
        <p className={styles.lead}>{mode === "edit" && submission === "review"
          ? "編集内容は審査に提出され、承認後に公開版に反映されます。"
          : description}</p>
      </header>
      <form className={styles.form} onSubmit={submit}>
        {error ? <p className={styles.formError} role="alert">{error}</p> : null}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-title">タイトル</label>
          <input id="notice-title" className={styles.input} value={title} required
            readOnly={busy || Boolean(acceptedRequest)}
            aria-describedby="notice-title-help" onChange={(event) => setTitle(event.target.value)} />
          <p id="notice-title-help" className={styles.help}>100文字まで</p>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-body">本文</label>
          <textarea id="notice-body" className={styles.textarea} value={body} required rows={11}
            readOnly={busy || Boolean(acceptedRequest)}
            aria-describedby="notice-body-help" onChange={(event) => setBody(event.target.value)} />
          <p id="notice-body-help" className={styles.help}>プレーンテキストで10,000文字まで</p>
        </div>
        <p className={styles.meta}>カテゴリー　{NOTICE_CATEGORY.name}</p>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="submit" disabled={busy}>
            {busy ? "処理中…" : acceptedRequest ? "申請詳細を開く" : mode === "resubmit" ? "再申請する" : label}
          </button>
          <Link className={styles.textButton} href={acceptedRequest ? myNoticeHref({}, new URLSearchParams(props.listSearch)) : cancelHref}>
            {acceptedRequest ? "自分のお知らせへ" : "キャンセル"}
          </Link>
        </div>
      </form>
    </>
  );
}

export function ConfirmNoticeAction({ operation, subject, target, version, hasPendingEdit = false, retentionDays }: {
  operation: "delete" | "withdraw";
  /** 削除済み本文を閲覧できる日数。サーバー側の `deletedNoticeRetentionDays` を渡す。 */
  retentionDays?: number;
  subject: string;
  target: string;
  version: number;
  hasPendingEdit?: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<PendingMutation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleting = operation === "delete";
  const label = deleting ? "お知らせを削除" : "申請を取り下げる";

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await sendMutation(deleting ? `/api/v1/notices/${encodeURIComponent(target)}/deletion`
        : `/api/v1/me/notice-requests/${encodeURIComponent(target)}/withdrawal`,
        deleting ? { expectedVersion: version, confirmed: true } : { expectedVersion: version }, pending);
      dialog.current?.close();
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "処理に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      <dialog ref={dialog} className={styles.confirmDialog} aria-labelledby={`notice-${operation}-heading`}
        aria-describedby={`notice-${operation}-description`} onCancel={(event) => { if (busy) event.preventDefault(); }}>
        <form onSubmit={confirm} className={styles.dialogContent}>
          <h2 className={styles.sectionTitle} id={`notice-${operation}-heading`}>{label}</h2>
          <p className={styles.dialogSubject}>{subject}</p>
          <p className={styles.lead} id={`notice-${operation}-description`}>
            {deleting
              ? `削除すると一般公開から外れ、本文は${retentionDays ? `削除から${retentionDays}日未満のみ` : "一定期間のみ"}閲覧できます。${hasPendingEdit ? "審査中の編集申請も同時に取り下げます。" : ""}`
              : "この申請の審査を取り消します。取り下げた内容は申請履歴に残ります。"}
          </p>
          {error ? <p className={styles.formError} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button autoFocus type="button" className={styles.secondaryButton} disabled={busy}
              onClick={() => dialog.current?.close()}>キャンセル</button>
            <button type="submit" className={styles.dangerButton} disabled={busy}>
              {busy ? "処理中…" : deleting ? "削除する" : "取り下げる"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
