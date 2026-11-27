"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import styles from "./delete-confirm.module.css";

/**
 * 質問・回答等の本人削除の確認（QA-02、API-QA-06・11）。最終確認のダイアログで「削除する」を選んだときだけ送信する。
 *
 * - 表示した版番号と `confirmed: true` を送る。版番号が古ければ 409 で拒否され、画面の再読込を案内する。
 * - 結果を確認できなかった場合は、同じ Idempotency-Key で送り直し、同じ操作として結果を確認できるようにする。
 * - 削除の可否は、表示に使った `capabilities.canDelete` ではなく、APIで再認可する。
 */
export function DeleteConfirm({ target, id, version, label, subject, description, onDeleted }: {
  target: "question" | "response";
  id: string;
  version: number;
  /** ボタンとダイアログの見出し（例：「質問を削除」）。 */
  label: string;
  /** 削除する投稿を示す文（質問のタイトル、回答等の冒頭など）。 */
  subject: string;
  /** 削除の結果の説明。子の投稿が残ることなど。 */
  description: string;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 閉じている間はダイアログの中身を描画しない。本文の冒頭が、画面の本文と重複して読み上げ・検索されないようにする。
  const [shown, setShown] = useState(false);
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (shown && !dialog.current?.open) dialog.current?.showModal();
  }, [shown]);

  function show() {
    setError("");
    setShown(true);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const path = target === "question" ? "questions" : "responses";
      const response = await fetch(`/api/v1/${path}/${encodeURIComponent(id)}/deletion`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key.current },
        body: JSON.stringify({ expectedVersion: version, confirmed: true }),
      });
      const result: { error?: { code?: string } } | null = await response.json().catch(() => null);
      if (response.ok) {
        key.current = null;
        dialog.current?.close();
        onDeleted();
        return;
      }
      if (!result || response.status >= 500) throw new Error("Deletion result unavailable");
      key.current = null;
      const code = result.error?.code;
      if (response.status === 409 && code === "VERSION_CONFLICT") {
        setError("内容が更新されています。画面を再読込して、最新の内容を確認してから削除してください。");
      } else if ([401, 403, 404].includes(response.status)) {
        setError("現在この投稿を削除できません。ログイン状態や、すでに削除されていないかを確認してください。");
      } else {
        setError("削除できませんでした。時間をおいてもう一度お試しください。");
      }
    } catch {
      setError("削除の結果を確認できませんでした。もう一度「削除する」を選ぶと、同じ操作として確認できます。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.dangerQuiet} onClick={show}>{label}</button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId} aria-describedby={descriptionId}
        onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => setShown(false)}>
        {shown ? <form className={styles.content} method="dialog" onSubmit={confirm} aria-busy={busy}>
          <h2 className={styles.heading} id={headingId}>{label}</h2>
          <p className={styles.subject}>{subject}</p>
          <p className={styles.lead} id={descriptionId}>{description}</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button autoFocus type="button" className={styles.secondaryButton} disabled={busy}
              onClick={() => dialog.current?.close()}>キャンセル</button>
            <button type="submit" className={styles.dangerButton} disabled={busy}>
              {busy ? "削除中…" : "削除する"}
            </button>
          </div>
        </form> : null}
      </dialog>
    </>
  );
}

/** 質問の本人削除。削除後は画面を再取得し、削除の案内と残っている回答・コメントを表示する。 */
export function QuestionDelete({ questionId, version, title }: { questionId: string; version: number; title: string }) {
  const router = useRouter();
  return (
    <DeleteConfirm target="question" id={questionId} version={version} label="質問を削除" subject={title}
      description="削除すると、質問のタイトルと本文は表示されなくなり、元に戻せません。回答・コメントは削除されず、そのまま表示されます。"
      onDeleted={() => router.refresh()} />
  );
}
