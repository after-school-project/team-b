"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { outcomeMessage } from "@/app/admin/submit-outcome";
import { useSubmission } from "@/app/admin/use-submission";
import type { NotificationView } from "@/notifications/notifications";
import type { TargetState } from "@/notifications/targets";
import { formatDateTime, isAppPath, kindLabels, splitMessage, targetStateNotes } from "./labels";
import styles from "./page.module.css";

const readStates = ["read"] as const;

type NotificationListProps = {
  items: NotificationView[];
  /** 既読にした後にフォーカスを移す、一覧の見出しのID。 */
  headingId: string;
};

/**
 * 通知一覧の各通知（GE-06）。未読の通知には「既読にする」を表示する。
 * 既読にした後は、ボタンがなくなるためフォーカスを一覧の見出しへ移し、画面を再取得してヘッダーの未読件数も更新する。
 */
export function NotificationList({ items, headingId }: NotificationListProps) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  // 再取得が終わるまでの間も、既読にした通知を既読として表示する。
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set());

  function handleRead(id: string) {
    setReadIds((current) => new Set(current).add(id));
    setStatus("通知を既読にしました。");
    document.getElementById(headingId)?.focus();
    router.refresh();
  }

  return (
    <>
      <div role="status">{status ? <p className={styles.status}>{status}</p> : null}</div>
      <ul className={styles.list}>
        {items.map((notification) => (
          <NotificationItem
            key={notification.id}
            notification={notification}
            read={notification.readAt !== null || readIds.has(notification.id)}
            onRead={() => handleRead(notification.id)}
            onStart={() => setStatus(null)}
          />
        ))}
      </ul>
    </>
  );
}

function NotificationItem({ notification, read, onRead, onStart }: {
  notification: NotificationView;
  read: boolean;
  onRead: () => void;
  onStart: () => void;
}) {
  const { summary, detail } = splitMessage(notification.message);
  const messageId = `notification-${notification.id}`;
  return (
    <li className={read ? styles.item : styles.itemUnread}>
      <p className={styles.badges}>
        {read ? <span className={styles.badgeRead}>既読</span> : <span className={styles.badgeUnread}>未読</span>}
        <span className={styles.badgeInfo}>{kindLabels[notification.kind]}</span>
      </p>
      <p id={messageId} className={read ? styles.message : styles.messageUnread}>{summary}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      <p className={styles.meta}>
        <time dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time>
      </p>
      {notification.targetState === "available" ? null : <TargetNote state={notification.targetState} />}
      {notification.targetState === "available" || !read ? (
        <div className={styles.itemActions}>
          {notification.targetState === "available" ? (
            <OpenTargetButton notificationId={notification.id} describedBy={messageId} onStart={onStart} />
          ) : null}
          {read ? null : (
            <ReadButton notificationId={notification.id} describedBy={messageId} onRead={onRead} onStart={onStart} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function TargetNote({ state }: { state: Exclude<TargetState, "available"> }) {
  const note = targetStateNotes[state];
  return note ? <p className={styles.targetNote}>{note}</p> : null;
}

type OpenError = { message: string; reload: boolean };

/**
 * 通知の対象を開く。押したときに API-NT-04 で現在の権限と対象の状態を確認し、遷移できる場合だけ移動する。
 * 開いただけでは既読にしない。一覧の表示後に対象の状態が変わっていた場合は、状態案内を示して一覧を再取得する。
 */
function OpenTargetButton({ notificationId, describedBy, onStart }: {
  notificationId: string;
  describedBy: string;
  onStart: () => void;
}) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<OpenError | null>(null);

  async function open() {
    if (opening) return;
    setError(null);
    onStart();
    setOpening(true);
    let failure: OpenError;
    try {
      const response = await fetch(`/api/v1/notifications/${encodeURIComponent(notificationId)}/target`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { data?: { state?: unknown; path?: unknown } } | null;
      if (response.ok && body?.data?.state === "available" && isAppPath(body.data.path)) {
        router.push(body.data.path);
        return;
      }
      failure = openFailure(response.status, body?.data?.state);
    } catch {
      failure = { message: "通知の対象を確認できませんでした。時間をおいてもう一度お試しください。", reload: false };
    }
    setOpening(false);
    setError(failure);
    if (failure.reload) router.refresh();
  }

  return (
    <>
      <button type="button" className={styles.secondaryButton} disabled={opening} aria-describedby={describedBy}
        onClick={open}>
        {opening ? "確認しています…" : "対象を表示する"}
      </button>
      {error ? (
        <div className={styles.itemError} role="alert">
          <p>{error.message}</p>
        </div>
      ) : null}
    </>
  );
}

function openFailure(status: number, state: unknown): OpenError {
  if (status >= 200 && status < 300 && typeof state === "string" && state in targetStateNotes) {
    const note = targetStateNotes[state as keyof typeof targetStateNotes];
    return { message: note ?? "この通知の対象は、現在の権限では表示できません。", reload: true };
  }
  if (status === 401) return { message: "ログイン状態を確認できませんでした。再読み込みしてください。", reload: true };
  if (status === 403 || status === 404) {
    return { message: "この通知を表示できなくなりました。一覧を更新しました。", reload: true };
  }
  return { message: "通知の対象を確認できませんでした。時間をおいてもう一度お試しください。", reload: false };
}

function ReadButton({ notificationId, describedBy, onRead, onStart }: {
  notificationId: string;
  describedBy: string;
  onRead: () => void;
  onStart: () => void;
}) {
  const router = useRouter();
  const { sending, submit } = useSubmission(`/api/v1/notifications/${encodeURIComponent(notificationId)}/read`, readStates);
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null);

  async function markRead() {
    setError(null);
    onStart();
    const outcome = await submit({});
    if (outcome === null) return;
    if (outcome.kind === "done") {
      onRead();
      return;
    }
    setError(outcomeMessage(outcome.kind, "既読にする操作"));
  }

  return (
    <>
      <button type="button" className={styles.secondaryButton} disabled={sending} aria-describedby={describedBy}
        onClick={markRead}>
        {sending ? "既読にしています…" : "既読にする"}
      </button>
      {error ? (
        <div className={styles.itemError} role="alert">
          <p>{error.message}</p>
          {error.reload ? (
            <button type="button" className={styles.textButton} onClick={() => router.refresh()}>再読み込みする</button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
