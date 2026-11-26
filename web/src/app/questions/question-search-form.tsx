import type { Category } from "@/qa/questions";
import { resolutionLabels } from "./labels";
import type { QuestionFilterValues } from "./question-filters";
import styles from "./page.module.css";

type QuestionSearchFormProps = {
  categories: Category[];
  values: QuestionFilterValues;
  /** キーワードの修正が必要な場合の案内。 */
  keywordError: string | undefined;
};

/**
 * Q&A一覧の条件（QA-01）。通常の GET 送信で検索し、JavaScript がなくても使える。
 * キーワードの修正が必要な場合は、欄の近くとフォーム上部で案内し、入力した内容を保つ。
 */
export function QuestionSearchForm({ categories, values, keywordError }: QuestionSearchFormProps) {
  return (
    <>
      <form className={styles.filters} action="/questions" method="get" role="search" aria-label="質問の検索条件">
        {keywordError ? <p className={styles.formError} role="alert">検索条件を確認してください。（1件）</p> : null}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="question-q">キーワード</label>
          {/* maxLength は付けない。UTF-16単位で切り詰められ、サーバーのコードポイントの検証（API設計書 §3）と合わない。 */}
          <input
            id="question-q"
            className={styles.input}
            name="q"
            defaultValue={values.q}
            aria-invalid={keywordError ? true : undefined}
            aria-describedby={keywordError ? "question-q-error question-q-help" : "question-q-help"}
          />
          {keywordError ? <p id="question-q-error" className={styles.fieldError}>{keywordError}</p> : null}
          <p id="question-q-help" className={styles.help}>質問のタイトルと本文から探します。</p>
        </div>
        <div className={styles.selects}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="question-category">カテゴリー</label>
            <select id="question-category" className={styles.input} name="category" defaultValue={values.category}>
              <option value="">すべて</option>
              {categories.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="question-resolution">解決状態</label>
            <select id="question-resolution" className={styles.input} name="resolution" defaultValue={values.resolution || "all"}>
              <option value="all">すべて</option>
              <option value="open">{resolutionLabels.open}</option>
              <option value="resolved">{resolutionLabels.resolved}</option>
            </select>
          </div>
        </div>
        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton}>検索する</button>
          <button type="submit" form="question-clear" className={styles.textButton}>条件をクリア</button>
        </div>
      </form>
      {/* 条件のクリアは項目のない別のフォームで送信する。検索前（同じURL）でもページを読み直し、未送信の入力も消す。 */}
      <form id="question-clear" action="/questions" method="get" hidden />
    </>
  );
}
