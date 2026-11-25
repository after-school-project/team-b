"use client";

import Link from "next/link";
import { ErrorState } from "@/components/feedback/StateMessage";
import styles from "./state-page.module.css";

/** 画面の表示中に想定外の失敗が起きた場合の画面。例外の内容は表示しない。 */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className={styles.page}>
      <p className={styles.brand}>After School Project</p>
      <h1 className={styles.title}>画面を表示できません</h1>
      <ErrorState
        title="読み込めませんでした。もう一度お試しください。"
        description={<p className={styles.text}>繰り返し表示される場合は、時間をおいてお試しください。</p>}
        action={
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => retry()}>もう一度読み込む</button>
            <Link className={styles.link} href="/">ホームへ戻る</Link>
          </div>
        }
      />
    </main>
  );
}
