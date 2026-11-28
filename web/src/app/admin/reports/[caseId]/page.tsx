import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { uuid } from "@/api/request";
import { ApiError, type PageInfo } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAdminScreen } from "@/components/app-shell/screen";
import { RestrictedMarkdown } from "@/components/markdown/RestrictedMarkdown";
import { readForScreen } from "@/db/screen-read";
import { loadQuestion } from "@/qa/questions";
import { loadResponse } from "@/qa/responses";
import {
  listAssigneeCandidates, listCaseActions, listCaseEvidence, listCaseReports, loadCase, loadCaseEvidence, readCases,
} from "@/reports/case-reads";
import { casePriorityLabels, caseStatusLabels, reportReasonLabels, reportTargetLabels } from "@/reports/labels";
import { VisibilityAction } from "../../../questions/[questionId]/visibility-action";
import styles from "../../admin.module.css";
import { baseRoleLabels, formatDateTime } from "../../labels";
import reportStyles from "../reports.module.css";
import { CaseOperations } from "./case-operations";

export const metadata: Metadata = { title: "通報案件の詳細" };

const actionLabels: Record<string, string> = {
  case_closed: "案件を完了", case_updated: "状態・優先度を変更", assignee_changed: "担当者を変更", note_added: "メモを追加",
  handoff_started: "引継ぎ待ちに移行", handoff_resolved: "担当者を再割当", school_only_applied: "学校専用に変更",
  profile_hidden: "プロフィールを非表示", qa_hidden: "投稿を非表示", qa_restored: "投稿を復元",
};
const handoffLabels = {
  manager_profile_hidden: "担当者のプロフィールが非表示", manager_suspended: "担当者が停止中", manager_role_revoked: "担当者の管理権限を解除",
  target_deleted: "対象の投稿を削除", subject_became_app_manager: "対象者にアプリ管理権限を付与",
};

type History = Awaited<ReturnType<typeof listCaseActions>>["data"]["items"][number];
type CursorField = "reportsCursor" | "actionsCursor" | "evidenceCursor" | "candidatesCursor";
const sections: Record<CursorField, string> = {
  reportsCursor: "reports", actionsCursor: "actions", evidenceCursor: "evidence", candidatesCursor: "case-operations",
};

function historyDetails({ beforeState: before, afterState: after }: History) {
  if (!after) return [];
  const fields = [];
  if (after.status && after.status !== before?.status) fields.push(`対応状態 ${caseStatusLabels[after.status]}`);
  if (after.priority && after.priority !== before?.priority) fields.push(`優先度 ${casePriorityLabels[after.priority]}`);
  if (after.assigneeId !== undefined && after.assigneeId !== before?.assigneeId) fields.push(`担当者 ${after.assigneeId ?? "未割当"}`);
  if (after.trigger) fields.push(handoffLabels[after.trigger]);
  return fields;
}

function EvidenceContent({ evidence }: { evidence: Awaited<ReturnType<typeof loadCaseEvidence>> }) {
  const content = evidence.content;
  if (evidence.targetType === "question" || evidence.targetType === "response") {
    return (
      <>
        {typeof content.title === "string" ? <h3 className={styles.subTitle}>{content.title}</h3> : null}
        {typeof content.authorLabel === "string" ? <p className={styles.meta}>{content.authorLabel}</p> : null}
        {typeof content.bodyMarkdown === "string" ? <RestrictedMarkdown source={content.bodyMarkdown} headingLevel={3} /> : null}
      </>
    );
  }

  const fields = content.fields && typeof content.fields === "object" ? content.fields as Record<string, unknown> : content;
  const role = content.baseRole === "student" || content.baseRole === "alumni" || content.baseRole === "staff"
    ? baseRoleLabels[content.baseRole] : null;
  const values = [
    ["利用者ID", content.userId], ["表示名", fields.displayName], ["所属", role], ["学科", fields.department],
    ["入学年度", fields.entryYear], ["卒業年度", fields.graduationYear], ["卒業予定", content.isGraduating === true ? "はい" : null],
  ];
  const options = fields.optionalFields;
  if (options && typeof options === "object") {
    for (const [key, label] of [["bio", "自己紹介"], ["occupation", "職種"], ["interests", "関心分野"]]) {
      const entry = (options as Record<string, { visibility?: string; value?: unknown }>)[key];
      if (entry?.visibility === "members") values.push([label, entry.value]);
    }
  }
  return <dl className={styles.details}>{values.map(([label, value]) => typeof label === "string" &&
    (typeof value === "string" || typeof value === "number") ? (
      <div key={label}><dt>{label}</dt><dd className={styles.multiline}>{value}</dd></div>
    ) : null)}</dl>;
}

export default async function ReportCasePage({ params, searchParams }: {
  params: Promise<{ caseId: string }>; searchParams: Promise<ScreenSearchParams>;
}) {
  const [{ caseId: rawId }, query] = await Promise.all([params, searchParams]);
  const id = uuid.safeParse(rawId);
  const path = `/admin/reports/${encodeURIComponent(rawId)}`;
  const { viewer, shell, access } = await requireAdminScreen("any", path, query);
  if (access === "denied") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
  if (!id.success) notFound();
  const caseId = id.data;

  const view = new URLSearchParams();
  for (const name of [...Object.keys(sections), "tab", "evidenceId"]) {
    if (typeof query[name] === "string") view.set(name, query[name]);
  }
  const itemQuery = (field: CursorField) => ({ limit: 20, cursor: view.get(field) ?? undefined });
  let result;
  try {
    result = await readForScreen((db) => readCases(db, viewer.userId, async (reader, current) => {
      const reportCase = await loadCase(reader, current, caseId);
      const reports = await listCaseReports(reader, current, caseId, itemQuery("reportsCursor"));
      const actions = await listCaseActions(reader, current, caseId, itemQuery("actionsCursor"));
      const candidates = reportCase.capabilities.canAssign
        ? await listAssigneeCandidates(reader, current, caseId, itemQuery("candidatesCursor")) : null;
      const evidence = reportCase.capabilities.canViewEvidence
        ? await listCaseEvidence(reader, current, caseId, itemQuery("evidenceCursor")) : null;
      const evidenceId = uuid.safeParse(view.get("evidenceId"));
      let snapshot = null;
      if (evidence && evidenceId.success) {
        try {
          snapshot = await loadCaseEvidence(reader, current, caseId, evidenceId.data);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") throw error;
        }
      }
      const { target } = reportCase;
      const post = target.sourceState !== "deleted" && target.type === "question" ? await loadQuestion(reader, current, target.id)
        : target.sourceState !== "deleted" && target.type === "response" ? await loadResponse(reader, current, target.id) : null;
      return { reportCase, reports, actions, evidence, snapshot, candidates, post };
    }));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "NOT_FOUND") notFound();
    if (error.code === "FORBIDDEN") return <AppShell viewer={shell}><AdminAccessDenied /></AppShell>;
    if (error.code !== "INVALID_CURSOR") throw error;
    return <AppShell viewer={shell}><div className={styles.formError} role="alert">
      <p>一覧の続きを表示できませんでした。</p><Link href={path}>案件の詳細に戻る</Link>
    </div></AppShell>;
  }

  function href(changes: Record<string, string | null>, section: string) {
    const next = new URLSearchParams(view);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `${path}${next.size ? `?${next}` : ""}#${section}`;
  }

  function navigation(field: CursorField, page: PageInfo, label: string): ReactNode {
    if (!view.has(field) && !page.nextCursor) return null;
    return <nav className={styles.links} aria-label={`${label}のページ送り`}>
      {view.has(field) ? <Link href={href({ [field]: null }, sections[field])}>最初のページ</Link> : null}
      {page.nextCursor ? <Link href={href({ [field]: page.nextCursor }, sections[field])}>次のページ</Link> : null}
    </nav>;
  }

  const { reportCase, reports, actions, evidence, snapshot, candidates, post } = result;
  const { target } = reportCase;
  const response = post && "questionId" in post ? post : null;
  const targetPath = target.type === "question" ? `/questions/${target.id}`
    : response ? `/questions/${response.questionId}#response-${response.id}`
      : target.type === "profile" || target.type === "account" ? `/users/${encodeURIComponent(target.id)}` : null;
  const canUseMeasure = reportCase.capabilities.canUpdate && post && post.version !== null
    && (target.type === "question" || target.type === "response") && (post.capabilities.canHide || post.capabilities.canRestore);
  const listPath = view.get("tab") === "handoff" && viewer.roles.schoolManager ? "/admin/reports?tab=handoff" : "/admin/reports";

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.links}><Link href={listPath}>通報案件一覧へ</Link></p>
        <header className={styles.header}>
          <div className={reportStyles.inlineList}>
            <span className={reportCase.status === "closed" ? styles.badgeSuccess : styles.badgeInfo}>{caseStatusLabels[reportCase.status]}</span>
            {reportCase.handoffPending ? <span className={styles.badgeWarning}>引継ぎ待ち</span> : null}
            {reportCase.schoolOnly ? <span className={styles.badgeInfo}>学校専用</span> : null}
          </div>
          <h1 className={styles.title}>通報案件の詳細</h1>
        </header>
        <section className={styles.card} aria-labelledby="case-overview">
          <h2 id="case-overview" className={styles.sectionTitle}>案件概要</h2>
          <dl className={`${styles.details} ${reportStyles.breakText}`}>
            <div><dt>対象</dt><dd>{reportTargetLabels[target.type]}{target.label ? ` · ${target.label}` : ""}
              {target.sourceState !== "public" ? <span className={styles.badgeWarning}>{target.sourceState === "deleted" ? "削除済み" : "非表示"}</span> : null}
            </dd></div>
            <div><dt>対象者ID</dt><dd>{target.subjectUserId}</dd></div>
            <div><dt>優先度</dt><dd>{casePriorityLabels[reportCase.priority]}</dd></div>
            <div><dt>担当者</dt><dd>{reportCase.assignee ? `${reportCase.assignee.displayName}（${reportCase.assignee.userId}）` : "未割当"}</dd></div>
            <div><dt>受付日時</dt><dd><time dateTime={reportCase.createdAt}>{formatDateTime(reportCase.createdAt)}</time></dd></div>
            {reportCase.closedAt ? <div><dt>終了日時</dt><dd><time dateTime={reportCase.closedAt}>{formatDateTime(reportCase.closedAt)}</time></dd></div> : null}
          </dl>
          <div className={styles.actions}>
            {targetPath && target.sourceState !== "deleted" ? <Link className={styles.itemLink} href={targetPath}>対象を開く</Link> : null}
            {canUseMeasure && post.version !== null && (target.type === "question" || target.type === "response") ? (
              <VisibilityAction target={target.type} id={target.id} kind={target.type === "question" ? "質問" : "投稿"}
                version={post.version} visibility={post.capabilities.canHide ? "hidden" : "public"} sourceCaseId={caseId} />
            ) : null}
          </div>
        </section>
        <CaseOperations reportCase={reportCase} candidates={candidates?.data.items ?? []} />
        {candidates ? navigation("candidatesCursor", candidates.page, "担当候補") : null}
        <section className={styles.card} aria-labelledby="reports">
          <h2 id="reports" className={styles.sectionTitle}>通報明細<span className={styles.count}>{reports.page.totalCount}件</span></h2>
          {reports.data.items.length ? <ul className={styles.list}>{reports.data.items.map((item) => (
            <li className={reportStyles.caseRow} key={item.id}>
              <strong>{reportReasonLabels[item.reason]}</strong>
              <p className={styles.meta}>{item.reporter.displayName}（{item.reporter.userId}） · {formatDateTime(item.createdAt)}</p>
              <p className={reportStyles.itemText}>{item.detailRedacted ? "詳細は学校管理者が確認できます。" : item.detail ?? "詳細なし"}</p>
            </li>
          ))}</ul> : <p className={styles.text}>通報明細はありません。</p>}
          {navigation("reportsCursor", reports.page, "通報明細")}
        </section>
        <section className={styles.card} aria-labelledby="actions">
          <h2 id="actions" className={styles.sectionTitle}>対応履歴<span className={styles.count}>{actions.page.totalCount}件</span></h2>
          {actions.data.items.length ? <ul className={styles.list}>{actions.data.items.map((item) => (
            <HistoryItem key={item.id} item={item} />
          ))}</ul> : <p className={styles.text}>対応履歴はありません。</p>}
          {navigation("actionsCursor", actions.page, "対応履歴")}
        </section>
        {evidence ? <section className={styles.card} aria-labelledby="evidence">
          <h2 id="evidence" className={styles.sectionTitle}>保全済みの証拠<span className={styles.count}>{evidence.page.totalCount}件</span></h2>
          {evidence.data.items.length ? <ul className={styles.list}>{evidence.data.items.map((item) => (
            <li className={reportStyles.caseRow} key={item.id}>
              <Link className={styles.itemLink} aria-current={snapshot?.id === item.id ? "true" : undefined}
                href={href({ evidenceId: item.id }, "evidence-content")}>取得日時 {formatDateTime(item.capturedAt)} の証拠</Link>
              {item.retentionExpiresAt ? <p className={styles.meta}>閲覧期限 {formatDateTime(item.retentionExpiresAt)}</p> : null}
            </li>
          ))}</ul> : <p className={styles.text}>閲覧できる証拠はありません。</p>}
          {navigation("evidenceCursor", evidence.page, "証拠")}
          {view.has("evidenceId") ? <div className={reportStyles.evidence} id="evidence-content">
            {snapshot ? <><h3 className={styles.subTitle}>証拠の内容</h3><EvidenceContent evidence={snapshot} /></>
              : <p className={styles.text}>この証拠は表示できません。</p>}
          </div> : null}
        </section> : null}
      </div>
    </AppShell>
  );
}

function HistoryItem({ item }: { item: History }) {
  const changes = historyDetails(item);
  return <li className={reportStyles.caseRow}>
    <strong>{actionLabels[item.actionType] ?? "案件の変更"}</strong>
    <p className={styles.meta}>{item.actor?.displayName ?? "システム"} · {formatDateTime(item.createdAt)}</p>
    {changes.length ? <p>{changes.join(" · ")}</p> : null}
    {item.noteRedacted ? <p className={styles.meta}>メモは学校管理者が確認できます。</p>
      : item.note ? <p className={reportStyles.itemText}>{item.note}</p> : null}
  </li>;
}
