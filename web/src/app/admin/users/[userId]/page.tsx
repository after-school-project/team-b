import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAdminUser, type AdminUserOverview } from "@/admin/users";
import { userId as userIdSchema } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import styles from "../../admin.module.css";
import { baseRoleLabels } from "../../labels";
import { HideProfilePanel } from "./hide-profile-panel";

export const metadata: Metadata = { title: "ユーザー管理" };

function roleLabels({ roles }: AdminUserOverview): string[] {
  return [...roles.schoolManager ? ["学校管理者"] : [], ...roles.appManager ? ["アプリ管理者"] : []];
}

/**
 * AD-11 ユーザー管理詳細・管理操作。利用者の基本情報とプロフィールの非表示（#8 ⑤）。
 * 停止・解除、権限変更、本人確認情報の照会は #16 で追加する。
 */
export default async function AdminUserPage({ params, searchParams }: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { userId } = await params;
  const { viewer, shell, access } = await requireAdminScreen(
    "any", `/admin/users/${encodeURIComponent(userId)}`, await searchParams,
  );
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (!userIdSchema.safeParse(userId).success) notFound();

  // DBクライアントは描画時に読み込む（ビルド時にDB接続情報を必要としない）。
  const { db } = await import("@/db/client");
  let user: AdminUserOverview;
  try {
    user = await loadAdminUser(db, viewer, userId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const roles = roleLabels(user);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <p className={styles.area}>管理エリア</p>
          <h1 className={styles.title}>ユーザー管理</h1>
        </header>

        <section className={styles.card} aria-labelledby="admin-user-summary">
          <h2 id="admin-user-summary" className={styles.sectionTitle}>{user.displayName}</h2>
          <dl className={styles.details}>
            <div>
              <dt>ユーザーID</dt>
              <dd>{user.userId}</dd>
            </div>
            <div>
              <dt>所属</dt>
              <dd>
                {baseRoleLabels[user.baseRole]}
                {user.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}
              </dd>
            </div>
            <div>
              <dt>管理権限</dt>
              <dd>{roles.length ? roles.map((role) => <span key={role} className={styles.badgeInfo}>{role}</span>) : "なし"}</dd>
            </div>
            <div>
              <dt>アカウント</dt>
              <dd>
                <span className={user.accountStatus === "active" ? styles.badgeSuccess : styles.badgeDanger}>
                  {user.accountStatus === "active" ? "利用中" : "停止中"}
                </span>
              </dd>
            </div>
            <div>
              <dt>プロフィール</dt>
              <dd>
                <span className={user.profileState === "public" ? styles.badgeSuccess : styles.badgeWarning}>
                  {user.profileState === "public" ? "公開中" : "非表示"}
                </span>
              </dd>
            </div>
          </dl>
          {user.profileState === "public"
            ? <p className={styles.links}><Link href={`/users/${encodeURIComponent(user.userId)}`}>公開プロフィールを見る</Link></p> : null}
        </section>

        <HideProfilePanel
          key={user.userId}
          userId={user.userId}
          displayName={user.displayName}
          version={user.version}
          appManager={user.roles.appManager}
          availability={user.profileHiding}
        />
      </div>
    </AppShell>
  );
}
