"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/dialog/ConfirmDialog";
import styles from "../../admin.module.css";
import { ReasonField, reasonError } from "../../reason-field";
import { outcomeMessage } from "../../submit-outcome";
import { useSubmission } from "../../use-submission";

type Action = { kind: "suspension"; suspended: boolean; sourceCaseId?: string } | { kind: "app-manager-role"; assigned: boolean };

export function AccountAction({ userId, displayName, version, action }: {
  userId: string;
  displayName: string | null;
  version: number;
  action: Action;
}) {
  const router = useRouter();
  const id = useId();
  const [publicReason, setPublicReason] = useState("");
  const [internalReason, setInternalReason] = useState("");
  const [validate, setValidate] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ message: string; reload: boolean; success?: boolean } | null>(null);
  const [completedVersion, setCompletedVersion] = useState<number | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const { sending, submit } = useSubmission(`/api/v1/admin/users/${encodeURIComponent(userId)}/${action.kind}`,
    ["suspended", "active", "assigned", "revoked"]);

  const suspension = action.kind === "suspension";
  const dangerous = suspension ? action.suspended : !action.assigned;
  const label = suspension ? (action.suspended ? "アカウントを停止" : "アカウントの停止を解除")
    : (action.assigned ? "アプリ管理者権限を付与" : "アプリ管理者権限を解除");
  const publicError = validate ? reasonError(publicReason, "本人向け理由") : null;
  const internalError = validate ? reasonError(internalReason, "内部理由") : null;
  const awaitingRefresh = version === completedVersion;

  useEffect(() => {
    if (message) feedback.current?.focus();
  }, [message]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || awaitingRefresh) return;
    setMessage(null);
    if (suspension) {
      setValidate(true);
      const invalid = reasonError(publicReason, "本人向け理由") ? "public"
        : reasonError(internalReason, "内部理由") ? "internal" : null;
      if (invalid) {
        document.getElementById(`${id}-${invalid}`)?.focus();
        return;
      }
    }
    setConfirming(true);
  }

  async function onConfirm() {
    setConfirming(false);
    const payload = suspension
      ? { expectedVersion: version, suspended: action.suspended, publicReason, internalReason, sourceCaseId: action.sourceCaseId }
      : { expectedVersion: version, assigned: action.assigned };
    const outcome = await submit(payload);
    if (!outcome) return;
    if (outcome.kind === "done") {
      setMessage({ message: `${label}しました。`, reload: false, success: true });
      setCompletedVersion(version);
      setValidate(false);
      setPublicReason("");
      setInternalReason("");
      router.refresh();
      return;
    }
    setMessage(outcomeMessage(outcome.kind, label));
  }

  return (
    <section className={styles.operationCard} aria-labelledby={`${id}-heading`}>
      <h2 className={styles.sectionTitle} id={`${id}-heading`}>{suspension ? "停止・解除" : "アプリ管理者権限"}</h2>
      {message ? (
        <div ref={feedback} role={message.success ? "status" : "alert"} tabIndex={-1}
          className={message.success ? styles.success : styles.formError}>
          <p>{message.message}</p>
          {message.reload ? <button type="button" className={styles.secondaryButton} onClick={() => router.refresh()}>
            最新の内容を読み込む
          </button> : null}
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit} noValidate aria-label={label}>
        {suspension ? <>
          <ReasonField id={`${id}-public`} label="本人向け理由" required="必須" help="本人向けの記録に保存します。"
            value={publicReason} error={publicError} disabled={sending || awaitingRefresh} onChange={setPublicReason} />
          <ReasonField id={`${id}-internal`} label="内部理由" required="必須" help="停止・解除の権限がある管理者向けの記録に保存します。"
            value={internalReason} error={internalError} disabled={sending || awaitingRefresh} onChange={setInternalReason} />
        </> : null}
        <div className={styles.actions}>
          <button type="submit" className={dangerous ? styles.dangerButton : styles.primaryButton} disabled={sending || awaitingRefresh}>
            {sending ? "送信中…" : `${label}する`}
          </button>
        </div>
      </form>
      <ConfirmDialog open={confirming} title={`${label}しますか？`} confirmLabel={`${label}する`} tone={dangerous ? "danger" : "primary"}
        onConfirm={onConfirm} onClose={() => setConfirming(false)}>
        <p>対象 {displayName ?? userId}</p>
        {suspension && action.suspended ? <p>本人は停止の案内とログアウトだけを利用できます。担当中の通報案件があれば、引継ぎ待ちになります。</p> : null}
        {!suspension && !action.assigned ? <p>本人は管理機能を利用できなくなります。担当中の通報案件があれば、引継ぎ待ちになります。</p> : null}
      </ConfirmDialog>
    </section>
  );
}
