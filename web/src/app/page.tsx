import { requireScreenViewer, type ScreenSearchParams } from "@/auth/screen";
import styles from "./page.module.css";

export default async function Home({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  // ホーム画面（GE-01）の内容は #18 で実装する。ここでは利用資格の確認だけを接続する。
  await requireScreenViewer("/", await searchParams);

  return (
    <main className={styles.main}>
      <h1>After School Project</h1>
      <p>学校・在校生・卒業生をつなぐコミュニティ</p>
      <p className={styles.status}>ただいま準備中です。</p>
    </main>
  );
}
