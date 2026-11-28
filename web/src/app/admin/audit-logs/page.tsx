import type { Metadata } from "next";
import Link from "next/link";
import { listAuditLogs, loadAuditLog, parseAuditLogs, type AuditLog } from "@/admin/audit-logs";
import { uuid } from "@/api/request";
import { ApiError } from "@/api/response";
import { readAdmin } from "@/auth/admin";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { readForScreen } from "@/db/screen-read";
import styles from "../admin.module.css";
import { formatDateTime } from "../labels";
import auditStyles from "../user-administration.module.css";

export const metadata: Metadata = { title: "監査ログ" };
const path = "/admin/audit-logs";
const actions: Record<string, string> = {
  "account.issued": "アカウントを発行",
  "account.password_reset": "パスワードを再発行",
  "account.suspended": "アカウントを停止",
  "account.resumed": "アカウントの停止を解除",
  "app_manager.assigned": "アプリ管理者権限を付与",
  "app_manager.revoked": "アプリ管理者権限を解除",
  "profile.hidden": "プロフィールを非表示",
  "profile_review.approved": "プロフィールの再公開を承認",
  "profile_review.rejected": "プロフィールの再公開を却下",
  "notice.hidden": "お知らせを非表示",
  "notice.restored": "お知らせを復元",
  "question.hidden": "質問を非表示",
  "question.restored": "質問を復元",
  "response.hidden": "投稿を非表示",
  "response.restored": "投稿を復元",
  "graduation.graduated": "卒業区分を更新",
  "graduation.corrected": "卒業区分を修正",
  "report_case.closed": "通報案件の対応を完了",
  "report_case.status_changed": "通報案件の状態を変更",
};

const stateLabels: Record<string, string> = {
  accountStatus: "アカウント", appManager: "アプリ管理者権限", version: "版番号",
  profileState: "プロフィール", publicationState: "公開状態", baseRole: "所属", isGraduating: "卒業予定",
  batchId: "一括処理ID", status: "状態", priority: "優先度", assigneeId: "担当者ID", handoffPending: "引継ぎ待ち",
};
const valueLabels: Record<string, string> = {
  active: "利用中", suspended: "停止中", public: "公開中", hidden: "非表示", pending: "審査待ち",
  approved: "承認済み", rejected: "却下", student: "在校生", alumni: "卒業生", unhandled: "未対応",
  in_progress: "対応中", closed: "対応済み", unset: "未設定", normal: "通常", high: "高",
};
const targets: Record<string, string> = {
  user: "利用者", profile_review: "プロフィール審査", notice: "お知らせ", event: "イベント",
  question: "質問", response: "投稿", report_case: "通報案件",
};

function label(labels: Record<string, string>, key: string) {
  return Object.hasOwn(labels, key) ? labels[key] : key;
}

function State({ value }: { value: AuditLog["beforeState"] }) {
  if (!value || Object.keys(value).length === 0) return <p className={styles.text}>変更項目なし</p>;
  return <dl className={styles.details}>{Object.entries(value).map(([key, item]) => (
    <div key={key}><dt>{label(stateLabels, key)}</dt>
      <dd>{typeof item === "boolean" ? (item ? "あり" : "なし") : item === null ? "未設定" : label(valueLabels, String(item))}</dd>
    </div>
  ))}</dl>;
}

function actorName(log: AuditLog) {
  return log.systemAction ? "システム" : log.actor ? `${log.actor.displayName}（${log.actor.userId}）` : "不明";
}

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const params = await searchParams;
  const { viewer, shell, access } = await requireAdminScreen("school", path, params);
  const denied = <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (access === "denied") return denied;

  const filters = new URLSearchParams();
  let result;
  try {
    for (const [name, value] of Object.entries(params)) {
      if (Array.isArray(value)) throw new ApiError("BAD_REQUEST");
      if (value !== undefined && name !== "logId") filters.set(name, value);
    }
    const query = parseAuditLogs(new URL(`http://app${path}?${filters}`));
    const logId = uuid.safeParse(params.logId);
    result = await readForScreen((db) => readAdmin(db, viewer.userId, async (reader, current) => {
      const list = await listAuditLogs(reader, current, query);
      let selected = null;
      if (logId.success) {
        try {
          selected = await loadAuditLog(reader, current, logId.data);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
        }
      }
      return { ...list, selected };
    }, "school"));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "FORBIDDEN") return denied;
    if (error.code !== "BAD_REQUEST" && error.code !== "INVALID_CURSOR") throw error;
  }

  function href(cursor?: string, logId?: string) {
    const next = new URLSearchParams(filters);
    if (cursor) next.set("cursor", cursor);
    else next.delete("cursor");
    if (logId) next.set("logId", logId);
    return `${path}${next.size ? `?${next}` : ""}${logId ? "#audit-detail" : ""}`;
  }
  const selected = result?.selected;

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.links}><Link href="/admin">管理エリアへ</Link></p>
        <h1 className={styles.title}>監査ログ</h1>
        {result ? <>
          <section className={styles.card} aria-labelledby="audit-list">
            <h2 className={styles.sectionTitle} id="audit-list">操作履歴<span className={styles.count}>{result.page.totalCount}件</span></h2>
            {result.data.items.length ? <ul className={styles.list}>{result.data.items.map((log) => (
              <li className={auditStyles.row} key={log.id}>
                <Link className={styles.itemLink} href={href(filters.get("cursor") ?? undefined, log.id)}
                  aria-current={log.id === selected?.id ? "true" : undefined}>
                  {label(actions, log.actionType)} · {formatDateTime(log.createdAt)}
                </Link>
                <p className={styles.meta}>{actorName(log)} · {label(targets, log.target.type)} {log.target.id}</p>
              </li>
            ))}</ul> : <p className={styles.text}>表示できる操作履歴はありません。</p>}
            {filters.has("cursor") || result.page.nextCursor ? (
              <nav className={styles.links} aria-label="監査ログのページ送り">
                {filters.has("cursor") ? <Link href={href()}>最初のページ</Link> : null}
                {result.page.nextCursor ? <Link href={href(result.page.nextCursor)}>次のページ</Link> : null}
              </nav>
            ) : null}
          </section>
          {params.logId !== undefined ? (
            <section className={styles.card} id="audit-detail" aria-labelledby="audit-detail-title" tabIndex={-1}>
              <h2 className={styles.sectionTitle} id="audit-detail-title">操作の詳細</h2>
              {selected ? <>
                <dl className={`${styles.details} ${auditStyles.breakText}`}>
                  <div><dt>操作</dt><dd>{label(actions, selected.actionType)}</dd></div>
                  <div><dt>日時</dt><dd><time dateTime={selected.createdAt}>{formatDateTime(selected.createdAt)}</time></dd></div>
                  <div><dt>操作者</dt><dd>{actorName(selected)}</dd></div>
                  <div><dt>対象</dt><dd>{label(targets, selected.target.type)} {selected.target.id}</dd></div>
                  {selected.publicReason ? <div><dt>公開理由</dt><dd>{selected.publicReason}</dd></div> : null}
                </dl>
                <h3 className={styles.subTitle}>変更前</h3><State value={selected.beforeState} />
                <h3 className={styles.subTitle}>変更後</h3><State value={selected.afterState} />
              </> : <p className={styles.text}>この操作履歴は表示できません。</p>}
            </section>
          ) : null}
        </> : <div className={styles.formError} role="alert">
          <p>監査ログのページを表示できませんでした。</p><Link href={path}>最初のページ</Link>
        </div>}
      </div>
    </AppShell>
  );
}
