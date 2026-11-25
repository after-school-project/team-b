import type { Metadata } from "next";
import Link from "next/link";
import styles from "./state-page.module.css";

export const metadata: Metadata = { title: "ページが見つかりません | After School Project" };

/**
 * 存在しないURLと、対象を表示できない場合（`notFound`）の画面。対象が存在するかを明かさない（画面遷移・状態遷移設計書 §4）。
 * Next.js はこの画面をすべてのページと一緒に描画するため、DBやセッションを読まない。そのため共通ナビも表示しない。
 */
export default function NotFound() {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>After School Project</p>
      <h1 className={styles.title}>ページが見つかりません</h1>
      <p className={styles.text}>URLが正しくないか、表示できないページです。</p>
      <Link className={styles.link} href="/">ホームへ戻る</Link>
    </main>
  );
}
