import type { Metadata } from "next";
import Link from "next/link";
import { loadAdminDashboard } from "@/admin/dashboard";
import { ApiError } from "@/api/response";
import { readAdmin } from "@/auth/admin";
import { matchesScreenRoute } from "@/auth/return-to";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import styles from "./admin.module.css";
import dashboardStyles from "./user-administration.module.css";

export const metadata: Metadata = { title: "管理エリア" };

export default async function AdminDashboardPage() {
  const { viewer, shell, access } = await requireAdminScreen("any", "/admin");
  const denied = <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (access === "denied") return denied;

  let dashboard;
  try {
    dashboard = await readForScreen((db) => readAdmin(db, viewer.userId, loadAdminDashboard));
  } catch (error) {
    if (error instanceof ApiError && error.code === "FORBIDDEN") return denied;
    throw error;
  }
  const { counts, navigation } = dashboard;
  const cards = [
    { enabled: navigation.canViewNotices, href: "/admin/notices", label: "お知らせの審査", count: counts.noticeRequests },
    { enabled: navigation.canViewEvents, href: "/admin/events", label: "イベントの審査", count: counts.eventRequests },
    { enabled: navigation.canViewReports, href: "/admin/reports", label: "未対応の通報", count: counts.unhandledReports },
  ];
  const menu = [
    { enabled: navigation.canViewUsers, href: "/admin/users", label: "ユーザー管理" },
    { enabled: navigation.canViewProfileReviews, href: "/admin/profile-reviews", label: "プロフィール再公開審査" },
    { enabled: navigation.canViewHandoffs, href: "/admin/reports?tab=handoff", label: "引継ぎ待ち案件" },
    { enabled: navigation.canViewGraduation, href: "/admin/graduation", label: "卒業区分変更" },
    { enabled: navigation.canViewAuditLogs, href: "/admin/audit-logs", label: "監査ログ" },
  ];
  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <h1 className={styles.title}>管理エリア</h1>
        <section aria-labelledby="pending-work">
          <h2 className={styles.sectionTitle} id="pending-work">対応待ち</h2>
          <ul className={dashboardStyles.cards}>
            {cards.filter(({ enabled }) => enabled).map(({ href, label, count }) => (
              <li key={href} className={styles.card}>
                {matchesScreenRoute(href) ? <Link className={styles.itemLink} href={href}>{label}</Link>
                  : <p className={styles.text}>{label}<span className={styles.badgeInfo}>準備中</span></p>}
                <p className={dashboardStyles.total}>{count}件</p>
              </li>
            ))}
          </ul>
        </section>
        <nav className={styles.card} aria-labelledby="admin-menu">
          <h2 className={styles.sectionTitle} id="admin-menu">管理メニュー</h2>
          <ul className={dashboardStyles.menu}>
            {menu.filter(({ enabled }) => enabled).map(({ href, label }) => (
              <li key={href}><Link className={styles.itemLink} href={href}>{label}</Link></li>
            ))}
          </ul>
        </nav>
      </div>
    </AppShell>
  );
}
