import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAdminUser, profileHidingFor, type AdminUserOverview } from "@/admin/users";
import { userId as userIdSchema, uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import { readAdmin } from "@/auth/admin";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import styles from "../../admin.module.css";
import { accountStatusLabels, baseRoleLabels, managerRoleLabels } from "../../labels";
import userStyles from "../../user-administration.module.css";
import { AccountAction } from "./account-action";
import { HideProfilePanel } from "./hide-profile-panel";
import { IdentityPanel } from "./identity-panel";

export const metadata: Metadata = { title: "ユーザー管理" };

function roleLabels({ roles }: AdminUserOverview): string[] {
  return [...roles.schoolManager ? [managerRoleLabels.school] : [], ...roles.appManager ? [managerRoleLabels.app] : []];
}

export default async function AdminUserPage({ params, searchParams }: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { userId } = await params;
  const query = await searchParams;
  const source = uuid.safeParse(query.sourceCaseId);
  const { viewer, shell, access } = await requireAdminScreen(
    "any", `/admin/users/${encodeURIComponent(userId)}`, query,
  );
  const denied = <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (access === "denied") return denied;
  if (!userIdSchema.safeParse(userId).success) notFound();

  let user: AdminUserOverview;
  try {
    user = await readForScreen((db) => readAdmin(db, viewer.userId, (reader, current) => loadAdminUser(reader, current, userId)));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    if (error instanceof ApiError && error.code === "FORBIDDEN") return denied;
    throw error;
  }
  const roles = roleLabels(user);

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.links}>
            <Link href="/admin/users">利用者一覧へ</Link>
            {source.success ? <Link href={`/admin/reports/${source.data}`}>通報案件へ</Link> : null}
          </div>
          <h1 className={styles.title}>ユーザー管理</h1>
        </header>

        <section className={styles.card} aria-labelledby="admin-user-summary">
          <h2 id="admin-user-summary" className={styles.sectionTitle}>{user.displayName ?? "非表示のプロフィール"}</h2>
          <dl className={`${styles.details} ${userStyles.breakText}`}>
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
                  {accountStatusLabels[user.accountStatus]}
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
            {user.suspensionReason ? <>
              <div><dt>本人向け理由</dt><dd>{user.suspensionReason.publicReason}</dd></div>
              <div><dt>内部理由</dt><dd>{user.suspensionReason.internalReason}</dd></div>
            </> : null}
          </dl>
          {user.profileState === "public"
            ? <p className={styles.links}><Link href={`/users/${encodeURIComponent(user.userId)}`}>公開プロフィールを見る</Link></p> : null}
        </section>

        {user.capabilities.canSuspend || user.capabilities.canResume ? (
          <AccountAction key={`${user.userId}:suspension`} userId={user.userId} displayName={user.displayName}
            version={user.version} action={{ kind: "suspension", suspended: user.capabilities.canSuspend, sourceCaseId: source.data }} />
        ) : null}
        {user.capabilities.canChangeAppManager ? (
          <AccountAction key={`${user.userId}:role`} userId={user.userId} displayName={user.displayName}
            version={user.version} action={{ kind: "app-manager-role", assigned: !user.roles.appManager }} />
        ) : null}
        {user.capabilities.canViewIdentity ? <IdentityPanel key={user.userId} userId={user.userId} /> : null}
        <HideProfilePanel
          key={user.userId}
          userId={user.userId}
          displayName={user.displayName}
          version={user.version}
          appManager={user.roles.appManager}
          availability={profileHidingFor(user)}
        />
      </div>
    </AppShell>
  );
}
