"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { outcomeMessage } from "@/app/admin/submit-outcome";
import { useSubmission } from "@/app/admin/use-submission";
import type { NotificationView } from "@/notifications/notifications";
import { formatDateTime, kindLabels, splitMessage } from "./labels";
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
      {read ? null : (
        <ReadButton notificationId={notification.id} describedBy={messageId} onRead={onRead} onStart={onStart} />
      )}
    </li>
  );
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
    <div className={styles.itemActions}>
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
    </div>
  );
}
