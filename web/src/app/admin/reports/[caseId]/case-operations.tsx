"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/dialog/ConfirmDialog";
import type { listAssigneeCandidates, loadCase } from "@/reports/case-reads";
import { casePriorities, casePriorityLabels, caseStatusLabels, caseStatuses } from "@/reports/labels";
import styles from "../../admin.module.css";
import { ReasonField, reasonError } from "../../reason-field";
import { outcomeMessage } from "../../submit-outcome";
import { useSubmission } from "../../use-submission";
import reportStyles from "../reports.module.css";

type Case = Awaited<ReturnType<typeof loadCase>>;
type Candidate = Awaited<ReturnType<typeof listAssigneeCandidates>>["data"]["items"][number];

export function CaseOperations({ reportCase, candidates }: { reportCase: Case; candidates: Candidate[] }) {
  const router = useRouter();
  const url = `/api/v1/admin/report-cases/${reportCase.id}`;
  const patch = useSubmission(url, caseStatuses, "PATCH");
  const assign = useSubmission(`${url}/assignment`, caseStatuses);
  const addNote = useSubmission(`${url}/notes`, caseStatuses);
  const inFlight = useRef(false);
  const noteId = useId();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [minimumVersion, setMinimumVersion] = useState(0);
  const [refreshing, refresh] = useTransition();
  const busy = patch.sending || assign.sending || addNote.sending || refreshing || reportCase.version < minimumVersion;
  const canChange = reportCase.capabilities.canUpdate;

  async function apply(operation: typeof patch, input: Record<string, unknown>, message: string) {
    if (inFlight.current || busy || !canChange) return;
    inFlight.current = true;
    setFeedback("");
    setError(null);
    try {
      const outcome = await operation.submit({ ...input, expectedVersion: reportCase.version });
      if (!outcome) return;
      if (outcome.kind !== "done") {
        setError(outcomeMessage(outcome.kind, "案件の更新"));
        return;
      }
      if (operation === addNote) setNote("");
      setFeedback(message);
      setMinimumVersion(reportCase.version + 1);
      refresh(() => router.refresh());
    } finally {
      inFlight.current = false;
    }
  }

  function saveCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const status = data.get("status");
    const priority = data.get("priority");
    if (status === reportCase.status && priority === reportCase.priority) {
      setError(null);
      setFeedback("変更はありません。");
      return;
    }
    void apply(patch, { status, priority }, "対応状態と優先度を保存しました。");
  }

  function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = reasonError(note, "対応メモ");
    setNoteError(invalid);
    if (invalid) document.getElementById(noteId)?.focus();
    else void apply(addNote, { note }, "対応メモを追加しました。");
  }

  return (
    <section className={styles.operationCard} aria-labelledby="case-operations" aria-busy={busy}>
      <h2 id="case-operations" className={styles.sectionTitle}>案件の対応</h2>
      {feedback ? <p className={styles.success} role="status">{feedback}</p> : null}
      {error ? <div className={styles.formError} role="alert">
        <p>{error.message}</p>
        {error.reload ? <button className={styles.secondaryButton} type="button" onClick={() => window.location.reload()}>再読み込み</button> : null}
      </div> : null}
      {!canChange ? <p className={styles.text}>対応済みの案件です。履歴と証拠を確認できます。</p> : (
        <>
          <form className={reportStyles.filters} onSubmit={saveCase} key={reportCase.version}>
            <label className={styles.field}>対応状態
              <select className={reportStyles.input} name="status" defaultValue={reportCase.status} disabled={busy}>
                <option value="unhandled">{caseStatusLabels.unhandled}</option>
                <option value="in_progress">{caseStatusLabels.in_progress}</option>
              </select>
            </label>
            <label className={styles.field}>優先度
              <select className={reportStyles.input} name="priority" defaultValue={reportCase.priority} disabled={busy}>
                {casePriorities.map((priority) => <option key={priority} value={priority}>{casePriorityLabels[priority]}</option>)}
              </select>
            </label>
            <button className={styles.primaryButton} type="submit" disabled={busy}>状態・優先度を保存</button>
          </form>
          {reportCase.capabilities.canAssign ? (
            <form className={reportStyles.filters} key={`assignment:${reportCase.version}:${candidates[0]?.userId ?? ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                const assigneeId = new FormData(event.currentTarget).get("assigneeId");
                if (assigneeId) void apply(assign, { assigneeId }, "担当者を設定しました。");
              }}>
              <label className={styles.field}>新しい担当者
                <select className={reportStyles.input} name="assigneeId" defaultValue="" disabled={busy || !candidates.length} required>
                  <option value="">担当者を選択</option>
                  {candidates.map((user) => (
                    <option key={user.userId} value={user.userId} disabled={user.userId === reportCase.assignee?.userId}>
                      {user.displayName ?? "表示名非公開"}（{user.userId}）
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={styles.secondaryButton} disabled={busy || !candidates.length}>担当者を設定</button>
            </form>
          ) : null}
          {reportCase.capabilities.canAddNote ? (
            <form className={styles.form} onSubmit={saveNote}>
              <ReasonField id={noteId} label="対応メモ" required="必須" help="案件の対応履歴に記録します。"
                value={note} error={noteError} disabled={busy} onChange={(value) => { setNote(value); setNoteError(null); }} />
              <div className={styles.actions}>
                <button type="submit" className={styles.secondaryButton} disabled={busy}>対応メモを追加</button>
              </div>
            </form>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} aria-haspopup="dialog" disabled={busy}
              onClick={() => setConfirmClose(true)}>対応済みにする</button>
          </div>
          <ConfirmDialog open={confirmClose} title="案件を対応済みにする" confirmLabel="対応済みにする" tone="primary"
            onClose={() => setConfirmClose(false)} onConfirm={() => {
              setConfirmClose(false);
              void apply(patch, { status: "closed" }, "案件を対応済みにしました。");
            }}>
            <p>完了後は閲覧専用になります。</p>
            {reportCase.handoffPending ? <p>あなたをこの案件の担当者として設定します。</p> : null}
          </ConfirmDialog>
        </>
      )}
    </section>
  );
}
