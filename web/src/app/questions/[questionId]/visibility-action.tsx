"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { ReasonField, reasonError } from "@/app/admin/reason-field";
import styles from "./delete-confirm.module.css";

type Visibility = "hidden" | "public";
type Reply = {
  data?: { resource: { type: string; id: string }; state: string; version: number };
  error?: { code: string; fields?: { path: string }[] };
};

export function VisibilityAction({ target, id, kind, version, visibility, sourceCaseId, onChanged }: {
  target: "question" | "response";
  id: string;
  kind: string;
  version: number;
  visibility: Visibility;
  sourceCaseId?: string;
  onChanged?: () => Promise<boolean>;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [committedVersion, setCommittedVersion] = useState(0);
  const [refreshing, refresh] = useTransition();
  const busy = sending || refreshing;
  const awaitingVersion = version < committedVersion;
  const hiding = visibility === "hidden";
  const action = hiding ? "非表示にする" : "復元する";
  const label = `${kind}を${action}`;
  const reasonLabel = hiding ? "本人向け理由" : "復元理由";

  function open() {
    if (busy || awaitingVersion) return;
    if (!pending.current) setReason("");
    setInputError(null);
    setError("");
    setStatus("");
    dialog.current?.showModal();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || busy || awaitingVersion) return;
    const invalid = hiding || reason.trim() ? reasonError(reason, reasonLabel) : null;
    setInputError(invalid);
    if (invalid) {
      document.getElementById(reasonId)?.focus();
      return;
    }

    inFlight.current = true;
    setSending(true);
    setError("");
    const body = JSON.stringify({ expectedVersion: version, visibility, reason: reason.trim(), sourceCaseId });
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    try {
      const path = target === "question" ? "questions" : "responses";
      const response = await fetch(`/api/v1/admin/${path}/${encodeURIComponent(id)}/visibility`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body,
      });
      const result: Reply | null = await response.json().catch(() => null);
      if (response.ok) {
        const data = result?.data;
        if (data?.resource?.type !== target || data.resource.id !== id || data.state !== visibility
          || data.version !== version + 1) throw new Error("Visibility result unreadable");

        pending.current = null;
        setCommittedVersion(data.version);
        dialog.current?.close();
        const done = hiding ? "非表示にしました。" : "復元しました。";
        if (onChanged) {
          const loaded = await onChanged();
          setStatus(loaded ? done : `${done}画面を再読込すると最新の状態を表示します。`);
        } else {
          setStatus(done);
          refresh(() => router.refresh());
        }
        return;
      }
      if (!result?.error || response.status >= 500) throw new Error("Visibility result unavailable");
      pending.current = null;
      if (result.error.fields?.some(({ path }) => path === "reason")) {
        setInputError(`${reasonLabel}を確認してください。`);
      } else if (["VERSION_CONFLICT", "STATE_CONFLICT", "CASE_CLOSED"].includes(result.error.code)) {
        setError("投稿が更新されています。画面を再読込して、最新の状態を確認してください。");
      } else if ([401, 403, 404].includes(response.status)) {
        setError("現在この投稿の公開状態を変更できません。");
      } else {
        setError("公開状態を変更できませんでした。時間をおいてもう一度お試しください。");
      }
    } catch {
      setError("変更の結果を確認できませんでした。もう一度実行すると、同じ操作として確認できます。");
    } finally {
      setSending(false);
      inFlight.current = false;
    }
  }

  return (
    <>
      <button type="button" className={hiding ? styles.dangerQuiet : styles.secondaryButton}
        aria-haspopup="dialog" aria-disabled={busy || awaitingVersion} onClick={open}>{label}</button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
        onCancel={(event) => { if (sending) event.preventDefault(); }}>
        <form className={styles.content} method="dialog" onSubmit={submit} aria-busy={sending}>
          <h2 id={titleId} className={styles.heading}>{label}</h2>
          <p className={styles.lead}>{hiding
            ? "投稿の内容は本人と権限のある管理者だけに表示されます。"
            : "投稿の内容を利用者に再び公開します。"}</p>
          <ReasonField id={reasonId} label={reasonLabel} required={hiding ? "必須" : "任意"}
            help={hiding ? "入力した理由を投稿者に通知します。" : "入力した理由は監査ログに記録します。"}
            value={reason} error={inputError} disabled={sending} onChange={(value) => {
              setReason(value);
              setInputError(null);
            }} />
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} disabled={sending}
              onClick={() => dialog.current?.close()}>キャンセル</button>
            <button type="submit" className={hiding ? styles.dangerButton : styles.secondaryButton} disabled={sending}>
              {sending ? "変更中…" : action}
            </button>
          </div>
        </form>
      </dialog>
      <span role="status">{status}</span>
    </>
  );
}
