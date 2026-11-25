import type { CandidateFilterErrors, CandidateFilterName, CandidateFilterValues } from "./candidate-filters";
import admin from "../admin.module.css";
import styles from "./page.module.css";

const yearInput = { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 } as const;

/** 候補の検索条件。通常の GET 送信で検索し、修正が必要な欄があれば欄ごとに案内して入力を保つ。 */
export function CandidateSearchForm({ mode, values, errors }: {
  mode: "graduate" | "correction"; values: CandidateFilterValues; errors: CandidateFilterErrors;
}) {
  const errorCount = Object.keys(errors).length;
  const field = (name: CandidateFilterName, label: string, help?: string, input?: typeof yearInput) => {
    const id = `candidate-${name}`;
    const error = errors[name];
    return (
      <div className={admin.field}>
        <label className={admin.label} htmlFor={id}>{label}</label>
        <input
          {...input}
          id={id}
          className={styles.input}
          name={name}
          defaultValue={values[name]}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? `${id}-error` : "", help ? `${id}-help` : ""].filter(Boolean).join(" ") || undefined}
        />
        {error ? <p id={`${id}-error`} className={admin.fieldError}>{error}</p> : null}
        {help ? <p id={`${id}-help`} className={admin.help}>{help}</p> : null}
      </div>
    );
  };
  const modeInput = mode === "graduate" ? null : <input type="hidden" name="mode" value={mode} />;
  return (
    <>
      <form className={styles.search} action="/admin/graduation" method="get" role="search" aria-label="対象の検索条件">
        {errorCount > 0 ? (
          <p className={admin.formError} role="alert">検索条件を確認してください。（{errorCount}件）</p>
        ) : null}
        {modeInput}
        {/* キーワードと学科に maxLength は付けない。UTF-16単位で切り詰められ、サーバーのコードポイントの検証と合わない。 */}
        {field("q", "キーワード", "公開表示名とユーザーIDから探します。非表示のプロフィールはユーザーIDで探せます。")}
        <div className={styles.searchRow}>
          {field("department", "学科")}
          {field("graduationYear", "卒業年度", "4桁の数字（例：2026）", yearInput)}
        </div>
        <div className={admin.actions}>
          <button type="submit" className={admin.secondaryButton}>検索する</button>
          <button type="submit" form="candidate-clear" className={styles.textButton}>条件をクリア</button>
        </div>
      </form>
      {/* 条件のクリアは項目のない別のフォームで送信し、未送信の入力も消す。 */}
      <form id="candidate-clear" action="/admin/graduation" method="get" hidden>{modeInput}</form>
    </>
  );
}
