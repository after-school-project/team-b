"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ProfileHidingAvailability } from "@/admin/users";
import { ConfirmDialog } from "@/components/dialog/ConfirmDialog";
import styles from "../../admin.module.css";
import { ReasonField, reasonError } from "../../reason-field";
import { outcomeMessage } from "../../submit-outcome";
import { useSubmission } from "../../use-submission";

const unavailableMessages: Record<Exclude<ProfileHidingAvailability, "available">, string> = {
  already_hidden: "このプロフィールは非表示です。公開に戻すには、本人の修正による再公開申請を審査します。",
  school_only: "アプリ管理者のプロフィールは、学校管理者だけが非表示にできます。",
  not_applicable: "学校管理者のプロフィールは、非表示の対象外です。",
};

/** AD-11 のプロフィール非表示の操作。許可される場合だけ入力欄とボタンを表示する。 */
export function HideProfilePanel({ userId, displayName, version, appManager, availability, sourceCaseId }: {
  userId: string;
  /** 公開表示名。非表示中は null（非表示にできる場合は必ずある）。 */
  displayName: string | null;
  /** 表示した利用者の版番号。 */
  version: number;
  appManager: boolean;
  availability: ProfileHidingAvailability;
  sourceCaseId?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; reload: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** 非表示にしたときの版番号。その後に再公開されて最新の状態を読み込んだ場合は、再び操作できるようにする。 */
  const [hiddenFrom, setHiddenFrom] = useState<number | null>(null);
  const hidden = hiddenFrom !== null && (availability !== "available" || version === hiddenFrom);
  const result = useRef<HTMLParagraphElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const { sending, submit } = useSubmission(`/api/v1/admin/users/${encodeURIComponent(userId)}/profile-hiding`, ["hidden"]);

  // 操作後は入力欄がなくなるため、フォーカスを結果へ移す。
  useEffect(() => {
    if (hidden) result.current?.focus();
  }, [hidden]);

  // 確認ダイアログを閉じた後の案内へフォーカスを移す。
  useEffect(() => {
    if (alert) alertBox.current?.focus();
  }, [alert]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const found = reasonError(reason, "非表示の理由");
    setError(found);
    setAlert(null);
    if (!found) setConfirming(true);
  }

  async function onConfirm() {
    setConfirming(false);
    const outcome = await submit({ expectedVersion: version, reason, sourceCaseId });
    if (!outcome) return;
    if (outcome.kind === "done") {
      setHiddenFrom(version);
      setReason("");
      router.refresh();
      return;
    }
    if (outcome.kind === "invalid") setError("非表示の理由を確認してください。");
    setAlert(outcomeMessage(outcome.kind, "プロフィールの非表示"));
  }

  return (
    <section className={styles.operationCard} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>プロフィールの非表示</h2>
      {hidden ? (
        <p ref={result} className={styles.success} role="status" tabIndex={-1}>プロフィールを非表示にしました。</p>
      ) : null}
      {!hidden && availability === "available" ? (
        <form className={styles.form} onSubmit={onSubmit} noValidate aria-label="プロフィールの非表示">
          <p className={styles.text}>
            非表示にすると、ほかの利用者にプロフィールが表示されなくなり、本人は新しい投稿や既存の投稿の編集ができなくなります。
            {appManager ? "アプリ管理者としての機能も使えなくなり、担当中の通報案件は引継ぎ待ちになります。" : ""}
          </p>
          {alert ? (
            <div ref={alertBox} className={styles.formError} role="alert" tabIndex={-1}>
              <p>{alert.message}</p>
              {alert.reload ? (
                <button type="button" className={styles.secondaryButton} onClick={() => window.location.reload()}>
                  最新の内容を読み込む
                </button>
              ) : null}
            </div>
          ) : null}
          <ReasonField
            id={`${id}-reason`} label="非表示の理由" required="必須" help="本人に通知されます。"
            value={reason} error={error} disabled={sending} onChange={setReason}
          />
          <div className={styles.actions}>
            <button type="submit" className={styles.dangerButton} disabled={sending}>
              {sending ? "送信中…" : "プロフィールを非表示にする"}
            </button>
          </div>
        </form>
      ) : null}
      {!hidden && availability !== "available" ? <p className={styles.text}>{unavailableMessages[availability]}</p> : null}
      {hidden || availability === "already_hidden" ? (
        <p className={styles.links}><Link href="/admin/profile-reviews">プロフィール再公開審査へ</Link></p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="プロフィールを非表示にしますか？"
        confirmLabel="非表示にする"
        onConfirm={onConfirm}
        onClose={() => setConfirming(false)}
      >
        <p>対象：{displayName}</p>
        <p>入力した理由が本人に通知されます。公開に戻すには、本人の修正と再公開の審査が必要です。</p>
      </ConfirmDialog>
    </section>
  );
}
