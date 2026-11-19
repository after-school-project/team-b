import Link from "next/link";
import type { ReactNode } from "react";
import { AppNavigation } from "./AppNavigation";
import type { AppShellViewer } from "./navigation";
import styles from "./AppShell.module.css";

export type AppShellProps = {
  /** サーバーで現在の利用資格・管理権限を確認した結果。クライアントの値で管理導線を出さない。 */
  viewer: AppShellViewer;
  /** 通知の未読件数。取得APIは #17 で接続する。未指定・0件はバッジを表示しない。 */
  unreadNotificationCount?: number;
  children: ReactNode;
};

/** ログイン後の画面で共通利用するレイアウト（SCR-01）。 */
export function AppShell({ viewer, unreadNotificationCount, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        本文へ移動
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/">
            After School Project
          </Link>
          <AppNavigation viewer={viewer} unreadNotificationCount={unreadNotificationCount} />
        </div>
      </header>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
