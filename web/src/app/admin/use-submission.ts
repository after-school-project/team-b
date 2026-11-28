"use client";

import { useRef, useState } from "react";
import { submitOutcome, type SubmitOutcome } from "./submit-outcome";

/**
 * 管理操作の送信。送信中の二重送信を防ぎ、確定したか確認できない間は、同じ内容なら同じ再送キーで送り直す。
 */
export function useSubmission<State extends string>(url: string, states: readonly State[], method: "POST" | "PATCH" = "POST") {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const pending = useRef<{ body: string; key: string } | null>(null);

  /** 送信する。既に送信中なら何もせず null を返す。 */
  async function submit(input: unknown): Promise<SubmitOutcome<State> | null> {
    if (sendingRef.current) return null;
    const body = JSON.stringify(input);
    const key = pending.current?.body === body ? pending.current.key : crypto.randomUUID();
    pending.current = { body, key };
    sendingRef.current = true;
    setSending(true);
    try {
      let outcome: SubmitOutcome<State>;
      try {
        const response = await fetch(url, {
          method, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body,
        });
        outcome = submitOutcome(response.status, await response.json().catch(() => null), states);
      } catch {
        // 送信できたか分からない（通信の途中切断を含む）。
        outcome = { kind: "unconfirmed" };
      }
      if (outcome.kind !== "unconfirmed") pending.current = null;
      return outcome;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return { sending, submit };
}
