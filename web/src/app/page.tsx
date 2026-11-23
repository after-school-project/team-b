import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import type { ScreenSearchParams } from "@/auth/screen";
import styles from "./page.module.css";

export default async function Home({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  // ホーム画面（GE-01）の4領域の内容は #18 で実装する。ここでは利用資格の確認と共通レイアウトを接続する。
  const { shell } = await requireAppScreen("/", await searchParams);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <h1 className={styles.title}>ホーム</h1>
        <p className={styles.lead}>学校・在校生・卒業生をつなぐコミュニティ</p>
        <p className={styles.status}>ただいま準備中です。</p>
      </div>
    </AppShell>
  );
}
