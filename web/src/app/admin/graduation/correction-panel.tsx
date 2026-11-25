"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GraduationCandidate } from "@/admin/graduation";
import { ConfirmDialog } from "@/components/dialog/ConfirmDialog";
import admin from "../admin.module.css";
import { outcomeMessage } from "../submit-outcome";
import { useSubmission } from "../use-submission";
import { graduationPath } from "./graduation-path";
import { nameLabel, stateLabel, type GraduationState } from "./labels";
import styles from "./page.module.css";

/** 指定できる区分。卒業生の卒業予定はない。 */
const states: readonly GraduationState[] = [
  { baseRole: "student", isGraduating: false },
  { baseRole: "student", isGraduating: true },
  { baseRole: "alumni", isGraduating: false },
];

/** 選択した利用者の卒業区分を、確認のうえ指定した区分へ修正する（AD-13、API-GR-03）。 */
export function CorrectionPanel({ candidate, closeHref }: { candidate: GraduationCandidate; closeHref: string }) {
  const router = useRouter();
  const id = useId();
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; reload: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ label: string; batchId: string | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const { sending, submit } = useSubmission("/api/v1/admin/graduation/corrections", ["corrected"]);

  // 一覧から選んだときは、詳細の見出しへフォーカスを移す。
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (alert) alertBox.current?.focus();
  }, [alert]);
  useEffect(() => {
    if (done) result.current?.focus();
  }, [done]);

  const current = stateLabel(candidate);
  const target = states.find((state) => stateLabel(state) === choice && choice !== current) ?? null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setAlert(null);
    setError(target ? null : "修正後の区分を選択してください。");
    if (target) setConfirming(true);
  }

  async function onConfirm() {
    setConfirming(false);
    if (!target) return;
    const outcome = await submit({
      userId: candidate.userId, expectedVersion: candidate.version,
      baseRole: target.baseRole, isGraduating: target.isGraduating, confirmed: true,
    });
    if (!outcome) return;
    if (outcome.kind === "done") {
      setDone({ label: stateLabel(target), batchId: outcome.resourceId });
      setChoice(null);
      router.refresh();
      return;
    }
    setDone(null);
    setAlert(outcomeMessage(outcome.kind, "区分の修正"));
  }

  return (
    <section className={admin.operationCard} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} ref={heading} className={admin.sectionTitle} tabIndex={-1}>
        {nameLabel(candidate.displayName)} の区分の修正
      </h2>
      {done ? (
        <div className={styles.result}>
          <p ref={result} className={admin.success} role="status" tabIndex={-1}>区分を「{done.label}」に修正しました。</p>
          {done.batchId ? (
            <p className={admin.links}><Link href={graduationPath("history", { batchId: done.batchId })}>この変更の履歴を見る</Link></p>
          ) : null}
        </div>
      ) : null}
      <dl className={admin.details}>
        <div><dt>ユーザーID</dt><dd>{candidate.userId}</dd></div>
        <div><dt>現在の区分</dt><dd>{current}</dd></div>
        <div><dt>学科</dt><dd>{candidate.department ?? "未設定"}</dd></div>
        <div><dt>入学年度</dt><dd>{candidate.entryYear ?? "未設定"}</dd></div>
        <div><dt>卒業年度</dt><dd>{candidate.graduationYear ?? "未設定"}</dd></div>
      </dl>
      <form className={admin.form} onSubmit={onSubmit} noValidate aria-label="区分の修正">
        {alert ? (
          <div ref={alertBox} className={admin.formError} role="alert" tabIndex={-1}>
            <p>{alert.message}</p>
            {alert.reload ? (
              <button type="button" className={admin.secondaryButton} onClick={() => window.location.reload()}>
                最新の内容を読み込む
              </button>
            ) : null}
          </div>
        ) : null}
        <fieldset className={styles.choices} role="radiogroup" aria-describedby={error ? `${id}-error` : undefined}>
          <legend className={admin.label}>修正後の区分<span className={admin.required}>必須</span></legend>
          {states.map((state) => {
            const label = stateLabel(state);
            return (
              <label key={label} className={styles.checkbox}>
                <input
                  type="radio" name={`${id}-state`} value={label}
                  checked={choice === label && label !== current} disabled={sending || label === current}
                  onChange={() => { setChoice(label); setError(null); }}
                />
                {label}{label === current ? "（現在の区分）" : ""}
              </label>
            );
          })}
        </fieldset>
        {error ? <p id={`${id}-error`} className={admin.fieldError} role="alert">{error}</p> : null}
        <div className={admin.actions}>
          <button type="submit" className={admin.primaryButton} disabled={sending}>
            {sending ? "修正中…" : "区分を修正する"}
          </button>
        </div>
      </form>
      <p className={admin.links}>
        <Link href={graduationPath("history", { userId: candidate.userId })}>この利用者の変更履歴</Link>
        <Link href={closeHref}>一覧だけを表示する</Link>
      </p>

      <ConfirmDialog
        open={confirming}
        title="区分を修正しますか？"
        confirmLabel="区分を修正する"
        tone="primary"
        onConfirm={onConfirm}
        onClose={() => setConfirming(false)}
      >
        <p>対象：{nameLabel(candidate.displayName)}（ID：{candidate.userId}）</p>
        <p>{current} → {target ? stateLabel(target) : ""}</p>
        <p>投稿・プロフィール・管理権限はそのままです。変更前後と実行者を履歴に残します。</p>
      </ConfirmDialog>
    </section>
  );
}
