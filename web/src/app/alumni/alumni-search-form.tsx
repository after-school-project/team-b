import type { InputHTMLAttributes } from "react";
import type { AlumniFieldErrors, AlumniFilterName, AlumniFilterValues } from "./field-errors";
import styles from "./page.module.css";

type FieldProps = {
  id: string;
  name: AlumniFilterName;
  label: string;
  value: string | undefined;
  error: string | undefined;
  /** 欄の下に表示する補足。 */
  help?: string;
  /** 複数の欄で共有する補足のID。 */
  sharedHelpId?: string;
  input?: InputHTMLAttributes<HTMLInputElement>;
};

/** 入力欄。補足とエラーを欄の近くに表示し、`aria-describedby` で関連付ける（docs/DESIGN.md §8.2）。 */
function Field({ id, name, label, value, error, help, sharedHelpId, input }: FieldProps) {
  const helpId = help ? `${id}-help` : sharedHelpId;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        className={styles.input}
        name={name}
        defaultValue={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, helpId].filter(Boolean).join(" ") || undefined}
      />
      {error ? <p id={errorId} className={styles.fieldError}>{error}</p> : null}
      {help ? <p id={helpId} className={styles.help}>{help}</p> : null}
    </div>
  );
}

const yearInput = { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } as const;

/**
 * 卒業生検索の条件（GE-04）。通常の GET 送信で検索し、JavaScript がなくても使える。
 * 修正が必要な欄があれば、欄ごとのエラーとフォーム上部の件数で案内し、入力した内容を保つ。
 */
export function AlumniSearchForm({ values, errors }: { values: AlumniFilterValues; errors: AlumniFieldErrors }) {
  const errorCount = Object.keys(errors).length;
  return (
    <>
      <form className={styles.filters} action="/alumni" method="get" role="search" aria-label="卒業生の検索条件">
        {errorCount > 0 ? (
          <p className={styles.formError} role="alert">検索条件を確認してください。（{errorCount}件）</p>
        ) : null}
        {/* キーワードと学科に maxLength は付けない。UTF-16単位で切り詰められ、サーバーのコードポイントの検証（API設計書 §3）と合わない。 */}
        <Field id="alumni-q" name="q" label="キーワード" value={values.q} error={errors.q}
          help="公開表示名・学科と、公開されている自己紹介・職種・関心分野から探します。" />
        <Field id="alumni-department" name="department" label="学科" value={values.department} error={errors.department} />
        <div className={styles.years}>
          <Field id="alumni-entry" name="entryYear" label="入学年度" value={values.entryYear} error={errors.entryYear}
            sharedHelpId="alumni-year-help" input={yearInput} />
          <Field id="alumni-graduation" name="graduationYear" label="卒業年度" value={values.graduationYear}
            error={errors.graduationYear} sharedHelpId="alumni-year-help" input={yearInput} />
        </div>
        <p id="alumni-year-help" className={styles.help}>年度は4桁の数字（例：2026）で入力します。</p>
        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton}>検索する</button>
          <button type="submit" form="alumni-clear" className={styles.textButton}>条件をクリア</button>
        </div>
      </form>
      {/* 条件のクリアは項目のない別のフォームで送信する。検索前（同じURL）でもページを読み直し、未送信の入力も消す。 */}
      <form id="alumni-clear" action="/alumni" method="get" hidden />
    </>
  );
}
