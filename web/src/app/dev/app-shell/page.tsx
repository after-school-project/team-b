import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/StateMessage";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "共通レイアウト確認 | After School Project",
};

export const dynamic = "force-dynamic";

type PreviewSearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * 共通レイアウトと状態表示部品の確認用ページ（Issue #3）。
 * 仮の権限値・未読件数で表示を切り替える。開発サーバー以外では存在しないページとして扱う。
 * 実際の画面では、#7 の認可基盤がサーバーで判定した閲覧者情報を AppShell に渡す。
 */
export default async function AppShellPreviewPage({ searchParams }: { searchParams: PreviewSearchParams }) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const params = await searchParams;
  const canAccessAdmin = params.admin === "1";
  const unread = Number(params.unread ?? "3");

  return (
    <AppShell
      viewer={{ displayName: "架空 太郎", canAccessAdmin }}
      unreadNotificationCount={Number.isFinite(unread) ? unread : 0}
    >
      <div className={styles.page}>
        <header className={styles.pageHeader}>
          <p className={styles.eyebrow}>開発用プレビュー</p>
          <h1 className={styles.title}>共通レイアウト確認</h1>
          <p className={styles.lead}>
            仮の権限値と未読件数で共通ナビゲーションと状態表示を確認します。各導線の遷移先は対応する画面の実装後に表示されます。
          </p>
        </header>

        <section className={styles.section} aria-labelledby="preview-controls">
          <h2 id="preview-controls" className={styles.sectionTitle}>
            表示条件
          </h2>
          <dl className={styles.conditions}>
            <dt>管理権限</dt>
            <dd>{canAccessAdmin ? "有効（管理エリアへの導線を表示）" : "なし（管理エリアへの導線を表示しない）"}</dd>
            <dt>通知の未読件数</dt>
            <dd>{Number.isFinite(unread) ? `${unread}件` : "0件"}</dd>
          </dl>
          <ul className={styles.links}>
            <li>
              <Link href={`/dev/app-shell?admin=${canAccessAdmin ? "0" : "1"}&unread=${unread}`}>
                {canAccessAdmin ? "管理権限なしで表示する" : "管理権限ありで表示する"}
              </Link>
            </li>
            <li>
              <Link href={`/dev/app-shell?admin=${canAccessAdmin ? "1" : "0"}&unread=${unread > 0 ? 0 : 3}`}>
                {unread > 0 ? "未読なしで表示する" : "未読ありで表示する"}
              </Link>
            </li>
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="preview-loading">
          <h2 id="preview-loading" className={styles.sectionTitle}>
            読み込み中
          </h2>
          <LoadingState />
        </section>

        <section className={styles.section} aria-labelledby="preview-empty">
          <h2 id="preview-empty" className={styles.sectionTitle}>
            空状態
          </h2>
          <EmptyState
            headingLevel={3}
            title="まだ質問はありません。"
            description="質問が投稿されると、ここに表示されます。"
          />
        </section>

        <section className={styles.section} aria-labelledby="preview-error">
          <h2 id="preview-error" className={styles.sectionTitle}>
            共通エラー
          </h2>
          <ErrorState
            headingLevel={3}
            action={
              <Link className={styles.retry} href={`/dev/app-shell?admin=${canAccessAdmin ? "1" : "0"}&unread=${unread}`}>
                再読み込みする
              </Link>
            }
          />
        </section>
      </div>
    </AppShell>
  );
}
