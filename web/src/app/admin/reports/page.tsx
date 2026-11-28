import type { Metadata } from "next";
import Link from "next/link";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import { listCases, parseCaseList, readCases } from "@/reports/case-reads";
import { casePriorities, casePriorityLabels, caseStatuses, caseStatusLabels, reportTargetLabels, reportTargetTypes } from "@/reports/labels";
import styles from "../admin.module.css";
import { formatDateTime } from "../labels";
import reportStyles from "./reports.module.css";

export const metadata: Metadata = { title: "通報案件" };
const path = "/admin/reports";

export default async function ReportCasesPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const handoffs = params.tab === "handoff";
  const scope = handoffs ? "school" : "any";
  const { viewer, shell, access } = await requireAdminScreen(scope, path, params);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;

  const filters = new URLSearchParams();
  let result;
  try {
    if (params.tab !== undefined && !handoffs) throw new ApiError("BAD_REQUEST");
    for (const [name, value] of Object.entries(params)) {
      if (Array.isArray(value)) throw new ApiError("BAD_REQUEST");
      if (name !== "tab" && value) filters.set(name, value);
    }
    const query = parseCaseList(new URL(`http://app${path}?${filters}`));
    result = await readForScreen((db) => readCases(db, viewer.userId,
      (reader, current) => listCases(reader, current, query, handoffs), scope));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "FORBIDDEN") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  }

  const tabPath = handoffs ? `${path}?tab=handoff` : path;
  function pageLink(cursor?: string) {
    const query = new URLSearchParams(filters);
    if (handoffs) query.set("tab", "handoff");
    if (cursor) query.set("cursor", cursor);
    else query.delete("cursor");
    return query.size ? `${path}?${query}` : path;
  }

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <h1 className={styles.title}>通報案件</h1>
        {viewer.roles.schoolManager ? (
          <nav className={styles.filters} aria-label="通報案件の表示範囲">
            <Link className={styles.filter} href={path} aria-current={!handoffs ? "page" : undefined}>案件一覧</Link>
            <Link className={styles.filter} href={`${path}?tab=handoff`} aria-current={handoffs ? "page" : undefined}>引継ぎ待ち</Link>
          </nav>
        ) : null}
        <section className={styles.card} aria-labelledby="case-list">
          <h2 id="case-list" className={styles.sectionTitle}>{handoffs ? "引継ぎ待ち案件" : "案件一覧"}
            {result ? <span className={styles.count}>{result.page.totalCount}件</span> : null}
          </h2>
          <form action={path} className={reportStyles.filters} aria-label="通報案件の絞り込み">
            {handoffs ? <input type="hidden" name="tab" value="handoff" /> : null}
            <label className={styles.field}>対応状態
              <select className={reportStyles.input} name="status" defaultValue={filters.get("status") ?? ""}>
                <option value="">すべて</option>
                {caseStatuses.map((status) => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
              </select>
            </label>
            <label className={styles.field}>優先度
              <select className={reportStyles.input} name="priority" defaultValue={filters.get("priority") ?? ""}>
                <option value="">すべて</option>
                {casePriorities.map((priority) => <option key={priority} value={priority}>{casePriorityLabels[priority]}</option>)}
              </select>
            </label>
            <label className={styles.field}>対象種別
              <select className={reportStyles.input} name="targetType" defaultValue={filters.get("targetType") ?? ""}>
                <option value="">すべて</option>
                {reportTargetTypes.map((type) => <option key={type} value={type}>{reportTargetLabels[type]}</option>)}
              </select>
            </label>
            {!handoffs ? <label className={styles.field}>担当者の利用者ID
              <input className={reportStyles.input} name="assigneeId" defaultValue={filters.get("assigneeId") ?? ""} />
            </label> : null}
            <button className={styles.secondaryButton} type="submit">絞り込む</button>
          </form>
          {!result ? <div className={styles.formError} role="alert"><p>一覧の条件を確認してください。</p><Link href={tabPath}>条件を解除する</Link></div>
            : result.data.items.length === 0 ? <p className={styles.text}>条件に一致する案件はありません。</p>
              : <ul className={styles.list}>
                {result.data.items.map((item) => (
                  <li className={reportStyles.caseRow} key={item.id}>
                    <div className={reportStyles.inlineList}>
                      <span className={item.status === "closed" ? styles.badgeSuccess : styles.badgeInfo}>{caseStatusLabels[item.status]}</span>
                      {item.handoffPending ? <span className={styles.badgeWarning}>引継ぎ待ち</span> : null}
                      {item.schoolOnly ? <span className={styles.badgeInfo}>学校専用</span> : null}
                    </div>
                    <Link className={styles.itemLink} href={`${path}/${item.id}${handoffs ? "?tab=handoff" : ""}`}>
                      {reportTargetLabels[item.target.type]} · {item.target.label ?? (item.target.sourceState === "deleted" ? "削除済み" : item.target.subjectUserId)}
                    </Link>
                    <p className={styles.meta}>優先度 {casePriorityLabels[item.priority]} · 担当 {item.assignee?.displayName ?? "未割当"} · 通報 {item.reportCount}件</p>
                    <time className={styles.meta} dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time>
                  </li>
                ))}
              </ul>}
          {result && (filters.has("cursor") || result.page.nextCursor) ? (
            <nav className={styles.links} aria-label="案件一覧のページ送り">
              {filters.has("cursor") ? <Link href={pageLink()}>最初のページ</Link> : null}
              {result.page.nextCursor ? <Link href={pageLink(result.page.nextCursor)}>次のページ</Link> : null}
            </nav>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
