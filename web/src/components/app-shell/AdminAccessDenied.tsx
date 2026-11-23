import Link from "next/link";
import { ErrorState } from "@/components/feedback/StateMessage";
import styles from "./AdminAccessDenied.module.css";

/**
 * 管理エリアの画面を、管理権限が足りない利用者が開いた場合の表示（`requireAdminScreen` が `denied` の場合）。
 * 管理データを返さず、権限変更の案内と一般ホームへの導線だけを表示する（画面遷移・状態遷移設計書 §4）。
 * どの権限が足りないかは示さない。`AppShell` の中に置く。
 */
export function AdminAccessDenied() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>管理エリア</h1>
      <ErrorState
        title="この画面を利用する権限がありません。"
        description={
          <p className={styles.description}>
            管理権限がないか、権限が変更された可能性があります。一般の機能は引き続き利用できます。
          </p>
        }
        action={
          <Link className={styles.homeLink} href="/">
            ホームへ戻る
          </Link>
        }
      />
    </div>
  );
}
