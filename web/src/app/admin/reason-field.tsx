"use client";

import { countCharacters } from "@/profile/limits";
import { reasonMaxLength } from "@/api/input-limits";
import styles from "./admin.module.css";

/** 理由の入力の案内。空白だけの入力と、コードポイントで上限を超える入力を送信前に示す（API設計書 §3 Reason）。 */
export function reasonError(reason: string, label: string): string | null {
  if (reason.trim() === "") return `${label}を入力してください。`;
  // 送信時にLFへ正規化される改行は1文字として数える。
  if (countCharacters(reason.replaceAll("\r\n", "\n")) > reasonMaxLength) {
    return `${label}は${reasonMaxLength}文字以内で入力してください。`;
  }
  return null;
}

export function ReasonField({ id, label, required, help, value, error, disabled, onChange }: {
  id: string;
  label: string;
  required: string;
  help: string;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}<span className={styles.required}>{required}</span></label>
      {/* maxLength はUTF-16単位で切り詰めるため付けない。文字数はサーバーと同じコードポイントで確認する。 */}
      <textarea
        id={id}
        className={styles.textarea}
        rows={4}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? `${id}-error` : "", `${id}-help`].filter(Boolean).join(" ")}
      />
      {error ? <p id={`${id}-error`} className={styles.fieldError}>{error}</p> : null}
      <p id={`${id}-help`} className={styles.help}>{help}{reasonMaxLength}文字以内（{countCharacters(value)}文字）</p>
    </div>
  );
}
