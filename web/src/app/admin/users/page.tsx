import type { Metadata } from "next";
import Link from "next/link";
import { adminUserBaseRoles, adminUserManagerRoles, adminUserStatuses, listAdminUsers, parseAdminUsers } from "@/admin/users";
import { ApiError } from "@/api/response";
import { readAdmin } from "@/auth/admin";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import styles from "../admin.module.css";
import { accountStatusLabels, baseRoleLabels, managerRoleLabels } from "../labels";
import userStyles from "../user-administration.module.css";

export const metadata: Metadata = { title: "ユーザー管理" };
const path = "/admin/users";

const userFilters = [
  { name: "baseRole", label: "所属", options: adminUserBaseRoles.map((value) => ({ value, label: baseRoleLabels[value] })) },
  { name: "accountStatus", label: "アカウント", options: adminUserStatuses.map((value) => ({ value, label: accountStatusLabels[value] })) },
  { name: "managerRole", label: "管理権限", options: adminUserManagerRoles.map((value) => ({ value, label: managerRoleLabels[value] })) },
];

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell, access } = await requireAdminScreen("any", path, params);
  const denied = <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (access === "denied") return denied;

  const filters = new URLSearchParams();
  let result;
  try {
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) throw new ApiError("BAD_REQUEST");
      if (value !== undefined && !(value === "" && ["q", ...userFilters.map(({ name }) => name)].includes(key))) {
        filters.set(key, value);
      }
    }
    const query = parseAdminUsers(new URL(`http://app${path}?${filters}`));
    result = await readForScreen((db) => readAdmin(db, viewer.userId, (reader, current) => listAdminUsers(reader, current, query)));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "FORBIDDEN") return denied;
    if (error.code !== "BAD_REQUEST" && error.code !== "INVALID_CURSOR") throw error;
  }

  function pageLink(cursor?: string) {
    const next = new URLSearchParams(filters);
    if (cursor) next.set("cursor", cursor);
    else next.delete("cursor");
    return next.size ? `${path}?${next}` : path;
  }

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.links}><Link href="/admin">管理エリアへ</Link></p>
        <h1 className={styles.title}>ユーザー管理</h1>
        <section className={styles.card} aria-labelledby="admin-users">
          <h2 className={styles.sectionTitle} id="admin-users">利用者一覧
            {result ? <span className={styles.count}>{result.page.totalCount}件</span> : null}
          </h2>
          <form action={path} className={userStyles.filters} aria-label="利用者の絞り込み">
            <label className={styles.field}>公開表示名・ユーザーID
              <input type="search" className={userStyles.control} name="q" defaultValue={filters.get("q") ?? ""} />
            </label>
            {userFilters.map(({ name, label, options }) => (
              <label className={styles.field} key={name}>{label}
                <select className={userStyles.control} name={name} defaultValue={filters.get(name) ?? ""}>
                  <option value="">すべて</option>
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ))}
            <button type="submit" className={styles.secondaryButton}>検索する</button>
          </form>
          {!result ? <div className={styles.formError} role="alert">
            <p>検索条件またはページを確認してください。</p><Link href={path}>条件を解除する</Link>
          </div> : !result.data.items.length ? <p className={styles.text}>条件に一致する利用者はいません。</p>
            : <ul className={styles.list}>{result.data.items.map((user) => (
              <li key={user.userId} className={userStyles.row}>
                <Link className={styles.itemLink} href={`${path}/${encodeURIComponent(user.userId)}`}>
                  {user.displayName ?? `表示名非公開（${user.userId}）`}
                </Link>
                {user.displayName !== null ? <p className={styles.meta}>{user.userId}</p> : null}
                <p className={styles.badges}>
                  <span className={styles.badgeInfo}>{baseRoleLabels[user.baseRole]}</span>{" "}
                  {user.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}{" "}
                  <span className={user.accountStatus === "active" ? styles.badgeSuccess : styles.badgeDanger}>
                    {accountStatusLabels[user.accountStatus]}
                  </span>{" "}
                  {user.roles.schoolManager ? <span className={styles.badgeInfo}>{managerRoleLabels.school}</span> : null}{" "}
                  {user.roles.appManager ? <span className={styles.badgeInfo}>{managerRoleLabels.app}</span> : null}
                </p>
              </li>
            ))}</ul>}
          {result && (filters.has("cursor") || result.page.nextCursor) ? (
            <nav className={styles.links} aria-label="利用者一覧のページ送り">
              {filters.has("cursor") ? <Link href={pageLink()}>最初のページ</Link> : null}
              {result.page.nextCursor ? <Link href={pageLink(result.page.nextCursor)}>次のページ</Link> : null}
            </nav>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
