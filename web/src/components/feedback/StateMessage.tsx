import type { ReactNode } from "react";
import styles from "./StateMessage.module.css";

type HeadingLevel = 2 | 3 | 4;

export type LoadingStateProps = {
  /** 支援技術にも読み上げる文言。 */
  label?: string;
};

/** 読み込み中の共通表示。`role="status"` で読み込み中であることを通知する。 */
export function LoadingState({ label = "読み込み中…" }: LoadingStateProps) {
  return (
    <div className={`${styles.state} ${styles.loading}`} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span className={styles.loadingLabel}>{label}</span>
    </div>
  );
}

export type EmptyStateProps = {
  /** 例：「まだ質問はありません。」 */
  title: string;
  description?: ReactNode;
  /** 一覧へのリンクや作成ボタンなど、次の操作。 */
  action?: ReactNode;
  headingLevel?: HeadingLevel;
};

/** 表示できる項目が0件の場合の共通表示。 */
export function EmptyState({ title, description, action, headingLevel = 2 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={`${styles.state} ${styles.empty}`}>
      <Heading className={styles.title}>{title}</Heading>
      {description ? <div className={styles.description}>{description}</div> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}

export type ErrorStateProps = {
  title?: string;
  description?: ReactNode;
  /** 再読み込みなど、利用者が取れる操作。 */
  action?: ReactNode;
  headingLevel?: HeadingLevel;
};

/**
 * 読み込み失敗などの共通エラー表示。色だけに頼らず「エラー」ラベルを併記し、`role="alert"` で通知する。
 * 権限不足や対象の非表示に関する文言は、API の返却方針に沿って呼び出し側で指定する。
 */
export function ErrorState({
  title = "読み込めませんでした。もう一度お試しください。",
  description,
  action,
  headingLevel = 2,
}: ErrorStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={`${styles.state} ${styles.error}`} role="alert">
      <span className={styles.label}>エラー</span>
      <Heading className={styles.title}>{title}</Heading>
      {description ? <div className={styles.description}>{description}</div> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
