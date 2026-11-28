"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { reportDetailMaxLength, reportReasonLabels, reportReasons, reportTargetLabels, reportTargetTypes } from "@/reports/labels";
import styles from "./ReportButton.module.css";

type ReportReason = (typeof reportReasons)[number];
type ReportTarget = (typeof reportTargetTypes)[number];

export function ReportButton({ type, id, label, kind = reportTargetLabels[type] }: {
  type: ReportTarget; id: string; label: string; kind?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonField = useRef<HTMLSelectElement>(null);
  const detailField = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const fieldId = useId();
  const [isOpen, setOpen] = useState(false);
  const [step, setStep] = useState<"input" | "confirm" | "done">("input");
  const [reason, setReason] = useState<ReportReason | "">("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<{ field?: "reason" | "detail"; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const length = [...detail].length;

  useEffect(() => {
    if (!isOpen || !dialog.current) return;
    if (!dialog.current.open) dialog.current.showModal();
    if (step === "input") reasonField.current?.focus();
    else heading.current?.focus();
  }, [isOpen, step]);

  function open() {
    if (step === "done") {
      setReason("");
      setDetail("");
      setStep("input");
    }
    setError(null);
    setOpen(true);
  }

  function close() {
    dialog.current?.close();
    setOpen(false);
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason) {
      setError({ field: "reason", message: "通報理由を選択してください。" });
      reasonField.current?.focus();
      return;
    }
    if (length > reportDetailMaxLength || (reason === "other" && detail.trim() === "")) {
      setError({ field: "detail", message: length > reportDetailMaxLength
        ? "詳細は500文字以内で入力してください。" : "その他を選ぶ場合は詳細を入力してください。" });
      detailField.current?.focus();
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function send() {
    if (inFlight.current || step !== "confirm") return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    const body = JSON.stringify({ target: { type, id }, reason, detail, confirmed: true });
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    try {
      const response = await fetch("/api/v1/reports", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body,
      });
      const result = await response.json().catch(() => null) as { data?: { received?: unknown; receivedAt?: unknown } } | null;
      if (response.status === 201 && result?.data?.received === true && typeof result.data.receivedAt === "string") {
        pending.current = null;
        setStep("done");
      } else if (response.ok || response.status >= 500 || result === null) {
        throw new Error("Report receipt unavailable");
      } else {
        pending.current = null;
        setError({ message: [401, 403, 404].includes(response.status)
          ? "現在この対象を通報できません。画面を再読み込みしてください。" : "通報を受け付けられませんでした。入力内容を確認してください。" });
      }
    } catch {
      setError({ message: "受付結果を確認できませんでした。内容を変えずにもう一度送信すると、同じ通報として確認します。" });
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.secondary} aria-haspopup="dialog" onClick={open}>{kind}を通報</button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${fieldId}-heading`}
        onCancel={(event) => {
          event.preventDefault();
          if (!inFlight.current) close();
        }}>
        {isOpen ? <div className={styles.content}>
          <h2 id={`${fieldId}-heading`} ref={heading} tabIndex={-1} className={styles.heading}>
            {step === "done" ? "通報を受け付けました" : step === "confirm" ? "通報内容の確認" : `${kind}を通報`}
          </h2>
          {step === "input" ? (
            <form className={styles.content} onSubmit={confirm} noValidate>
              <p className={styles.text}>{kind} · {label}</p>
              <div className={styles.field}>
                <label htmlFor={`${fieldId}-reason`}>通報理由（必須）</label>
                <select ref={reasonField} id={`${fieldId}-reason`} className={styles.input} required value={reason}
                  aria-invalid={error?.field === "reason" || undefined} aria-describedby={error?.field === "reason" ? `${fieldId}-error` : undefined}
                  onChange={(event) => { setReason(event.target.value as ReportReason | ""); setError(null); }}>
                  <option value="">理由を選択</option>
                  {reportReasons.map((code) => <option key={code} value={code}>{reportReasonLabels[code]}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor={`${fieldId}-detail`}>詳細（{reason === "other" ? "必須" : "任意"}）</label>
                <textarea ref={detailField} id={`${fieldId}-detail`} className={styles.input} rows={4} value={detail}
                  required={reason === "other"} aria-invalid={error?.field === "detail" || undefined}
                  aria-describedby={`${fieldId}-length${error?.field === "detail" ? ` ${fieldId}-error` : ""}`}
                  onChange={(event) => { setDetail(event.target.value); setError(null); }} />
                <p id={`${fieldId}-length`} className={styles.help}>{reportDetailMaxLength}文字以内（{length}文字）</p>
              </div>
              {error ? <p id={`${fieldId}-error`} className={styles.error} role="alert">{error.message}</p> : null}
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} onClick={close}>キャンセル</button>
                <button className={styles.primary} type="submit">送信前の確認へ</button>
              </div>
            </form>
          ) : step === "confirm" ? (
            <div className={styles.content} aria-busy={sending}>
              <dl className={styles.summary}>
                <div><dt>対象</dt><dd>{kind} · {label}</dd></div>
                <div><dt>理由</dt><dd>{reason && reportReasonLabels[reason]}</dd></div>
                {detail.trim() ? <div><dt>詳細</dt><dd>{detail}</dd></div> : null}
              </dl>
              <p className={styles.help}>送信後は内容を変更したり、取り下げたりできません。</p>
              {error ? <p className={styles.error} role="alert">{error.message}</p> : null}
              <div className={styles.actions}>
                <button className={styles.secondary} type="button" disabled={sending}
                  onClick={() => { setError(null); setStep("input"); }}>入力に戻る</button>
                <button className={styles.primary} type="button" disabled={sending} onClick={() => void send()}>
                  {sending ? "送信中…" : "通報を送信"}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={close}>閉じる</button>
            </div>
          )}
        </div> : null}
      </dialog>
    </>
  );
}
