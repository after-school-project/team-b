"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import styles from "../admin.module.css";
import { ReasonField, reasonError } from "../reason-field";
import { outcomeMessage } from "../submit-outcome";
import { useSubmission } from "../use-submission";

const messages = {
  approved: "お知らせの申請を承認しました。",
  rejected: "お知らせの申請を却下しました。",
  hidden: "お知らせを強制非表示にしました。",
  public: "お知らせを公開状態に戻しました。",
} as const;
const states = ["approved", "rejected", "hidden", "public"] as const;
type Action = "approve" | "reject" | "hidden" | "public";

export function NoticeAction({ id, version, action }: {
  id: string;
  version: number;
  action: "review" | "hidden" | "public" | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const feedback = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<ReturnType<typeof outcomeMessage> | null>(null);
  const [done, setDone] = useState<{ state: keyof typeof messages; version: number } | null>(null);
  const { sending, submit } = useSubmission(
    action === "review" ? `/api/v1/admin/notice-requests/${id}/decision` : `/api/v1/admin/notices/${id}/visibility`,
    states,
  );

  useEffect(() => {
    if (alert || done) feedback.current?.focus();
  }, [alert, done]);

  const review = action === "review";
  const label = review ? "却下の理由" : action === "hidden" ? "強制非表示の理由" : "復元の理由";

  async function perform(chosen: Action) {
    if (sending || done?.version === version) return;
    setDone(null);
    setAlert(null);
    const invalid = chosen !== "approve" && reason.trim() ? reasonError(reason, label) : null;
    setError(invalid);
    if (invalid) {
      document.getElementById(fieldId)?.focus();
      return;
    }
    const value = reason.trim() ? reason : null;
    const outcome = await submit(chosen === "approve" || chosen === "reject"
      ? { expectedVersion: version, decision: chosen, ...(chosen === "reject" ? { reason: value } : {}) }
      : { expectedVersion: version, visibility: chosen, reason: value });
    if (!outcome) return;
    if (outcome.kind === "done") {
      setReason("");
      setDone({ state: outcome.state, version });
      router.refresh();
      return;
    }
    setAlert(outcomeMessage(outcome.kind, review ? "審査" : "公開状態の変更"));
  }

  return (
    <>
      {done ? <div ref={feedback} className={styles.success} role="status" tabIndex={-1}>{messages[done.state]}</div> : null}
      {alert ? (
        <div ref={feedback} className={styles.formError} role="alert" tabIndex={-1}>
          <p>{alert.message}</p>
          {alert.reload ? <button type="button" className={styles.secondaryButton}
            onClick={() => window.location.reload()}>最新の内容を読み込む</button> : null}
        </div>
      ) : null}
      {action && done?.version !== version ? (
        <form className={styles.form} aria-label={review ? "お知らせの審査" : "お知らせの公開状態の変更"}
          aria-busy={sending} onSubmit={(event) => event.preventDefault()}>
          {review ? (
            <div className={styles.actions}>
              <button type="button" className={styles.primaryButton} disabled={sending}
                onClick={() => perform("approve")}>承認する</button>
            </div>
          ) : null}
          <div className={review ? styles.rejection : undefined}>
            <ReasonField id={fieldId} label={label} required="任意" help={review ? "入力した理由は本人への結果通知に含まれます。" : ""}
              value={reason} error={error} disabled={sending} onChange={(value) => { setReason(value); setError(null); }} />
            <div className={styles.actions}>
              <button type="button" className={action === "public" ? styles.primaryButton : styles.dangerButton}
                disabled={sending} onClick={() => perform(action === "review" ? "reject" : action)}>
                {review ? "却下する" : action === "hidden" ? "強制非表示にする" : "公開状態に戻す"}
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </>
  );
}
