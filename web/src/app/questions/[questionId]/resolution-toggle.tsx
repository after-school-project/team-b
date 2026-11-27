"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import styles from "./page.module.css";

type Resolution = "open" | "resolved";

const labels: Record<Resolution, { action: string; done: string }> = {
  resolved: { action: "解決済みにする", done: "解決済みにしました。" },
  open: { action: "未解決に戻す", done: "未解決に戻しました。" },
};

/**
 * 質問者本人による解決状態の変更（QA-02、API-QA-12）。切り替えではなく、設定する状態を送る。
 * 成功したら画面を再取得して、状態の表示と版番号を更新する。ボタンは再取得の後も同じ位置に残り、フォーカスを保つ。
 * 再取得が終わるまでは、変更前の版番号・状態のままのため、次の操作を受け付けない（古い版での送信を防ぐ）。
 * 結果を確認できなかった場合は、同じ Idempotency-Key で送り直せる。
 */
export function ResolutionToggle({ questionId, version, resolution }: {
  questionId: string;
  version: number;
  resolution: Resolution;
}) {
  const router = useRouter();
  const next: Resolution = resolution === "open" ? "resolved" : "open";
  const pending = useRef<{ body: string; key: string } | null>(null);
  // 送信中は、再描画を待たずに二重の送信を防ぐため ref でも判定する。
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const busy = sending || refreshing;
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function change() {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    const body = JSON.stringify({ expectedVersion: version, resolution: next });
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    let refreshStarted = false;
    setSending(true);
    setStatus("");
    setError("");
    try {
      const response = await fetch(`/api/v1/questions/${encodeURIComponent(questionId)}/resolution`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });
      const result: {
        data?: { resource?: { type?: string; id?: string }; state?: string };
        error?: { code?: string };
      } | null = await response.json().catch(() => null);
      if (response.ok) {
        // 有効な更新結果を読み取れるまでは、再送キーと本文を残し、同じ操作として送り直せるようにする（API設計書 §3）。
        const { resource, state } = result?.data ?? {};
        if (resource?.type !== "question" || resource.id !== questionId || state !== next) {
          throw new Error("Resolution result unreadable");
        }
        pending.current = null;
        setStatus(labels[next].done);
        // 再取得が終わる（`refreshing` が false に戻る）まで、次の操作を受け付けない。
        refreshStarted = true;
        startRefresh(() => router.refresh());
        return;
      }
      if (!result || response.status >= 500) throw new Error("Resolution result unavailable");
      pending.current = null;
      const code = result.error?.code;
      if (response.status === 409) {
        setError(code === "VERSION_CONFLICT" || code === "STATE_CONFLICT"
          ? "質問が更新されています。画面を再読込して、最新の状態を確認してください。"
          : "解決状態を変更できませんでした。画面を再読込して確認してください。");
      } else if (response.status === 403 && code === "PROFILE_WRITE_RESTRICTED") {
        setError("プロフィールが非表示のため、解決状態を変更できません。");
      } else if ([401, 403, 404].includes(response.status)) {
        setError("現在この質問の解決状態を変更できません。ログイン状態を確認してください。");
      } else {
        setError("解決状態を変更できませんでした。時間をおいてもう一度お試しください。");
      }
    } catch {
      setError("変更の結果を確認できませんでした。もう一度押すと、同じ操作として確認できます。");
    } finally {
      setSending(false);
      if (!refreshStarted) inFlight.current = false;
    }
  }

  // 再取得が終わったら、新しい版番号・状態で次の操作を受け付ける。
  useEffect(() => {
    if (!refreshing) inFlight.current = false;
  }, [refreshing]);

  return (
    <>
      {/* 変更中も無効化せずにフォーカスを保つ（無効にするとフォーカスが外れるため）。二重送信は busy で防ぐ。 */}
      <button type="button" className={styles.resolutionButton} onClick={change} aria-disabled={busy}>
        {busy ? "変更中…" : labels[next].action}
      </button>
      <span role="status" className={styles.ownerStatus}>{status}</span>
      {error ? <p className={styles.ownerError} role="alert">{error}</p> : null}
    </>
  );
}
