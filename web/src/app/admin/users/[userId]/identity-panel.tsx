"use client";

import { useEffect, useRef, useState } from "react";
import type { loadIdentityRecord } from "@/admin/users";
import styles from "../../admin.module.css";
import userStyles from "../../user-administration.module.css";

type Identity = Awaited<ReturnType<typeof loadIdentityRecord>>;

export function IdentityPanel({ userId }: { userId: string }) {
  const [state, setState] = useState<{ kind: "idle" | "loading" | "error" } | { kind: "open"; identity: Identity }>({ kind: "idle" });
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.kind === "open" || state.kind === "error") feedback.current?.focus();
  }, [state.kind]);

  async function openIdentity() {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(userId)}/identity`, { cache: "no-store" });
      if (!response.ok) {
        setState({ kind: "error" });
        return;
      }
      const { data }: { data: Identity } = await response.json();
      setState({ kind: "open", identity: data });
    } catch {
      setState({ kind: "error" });
    }
  }

  const identity = state.kind === "open" ? state.identity : null;
  return (
    <section className={styles.card} aria-labelledby="identity-title">
      <h2 id="identity-title" className={styles.sectionTitle}>本人確認情報</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} disabled={state.kind === "loading"}
          aria-expanded={state.kind === "open"}
          onClick={() => state.kind === "open" ? setState({ kind: "idle" }) : void openIdentity()}>
          {state.kind === "open" ? "本人確認情報を閉じる" : state.kind === "loading" ? "読み込み中…" : "本人確認情報を照会する"}
        </button>
      </div>
      {identity ? <div ref={feedback} tabIndex={-1}>
        <dl className={`${styles.details} ${userStyles.breakText}`}>
          <div><dt>実名</dt><dd>{identity.privateRealName ?? "未記録"}</dd></div>
          <div><dt>学校の照会情報</dt><dd>{identity.schoolReference ?? "未記録"}</dd></div>
          <div><dt>認証用メール</dt><dd>{identity.email}<span className={styles.badgeInfo}>{identity.emailVerified ? "確認済み" : "未確認"}</span></dd></div>
          <div><dt>照会メモ</dt><dd>{identity.verificationNote ?? "未記録"}</dd></div>
        </dl>
      </div> : null}
      {state.kind === "error" ? <div ref={feedback} tabIndex={-1} className={styles.formError} role="alert">
        <p>本人確認情報を取得できませんでした。</p>
      </div> : null}
    </section>
  );
}
