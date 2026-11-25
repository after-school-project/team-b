"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ProfileReview } from "@/profile/profile-reviews";
import styles from "../admin.module.css";
import { formatDateTime, reviewStatusLabels } from "../labels";
import { ReasonField, reasonError } from "../reason-field";
import { outcomeMessage } from "../submit-outcome";
import { useSubmission } from "../use-submission";

const statusBadges = { pending: styles.badgeWarning, approved: styles.badgeSuccess, rejected: styles.badgeDanger } as const;
const optionalFieldLabels = { bio: "自己紹介", occupation: "職種", interests: "関心分野" } as const;
const optionalFieldOrder = ["bio", "occupation", "interests"] as const;
const doneMessages = {
  approved: "再公開を承認しました。プロフィールは公開されました。",
  rejected: "再公開申請を却下しました。プロフィールは非表示のままです。",
} as const;

/** 選択した申請の内容と、承認・却下（AD-15）。内容は公開予定の項目だけで、本人のみの項目は含まれない。 */
export function ReviewDetail({ review, closeHref }: { review: ProfileReview; closeHref: string }) {
  const router = useRouter();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ message: string; reload: boolean } | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  /** 送信中の操作。 */
  const [action, setAction] = useState<"approve" | "reject" | null>(null);
  const { sending, submit } = useSubmission(
    `/api/v1/admin/profile-reviews/${review.id}/decision`, ["approved", "rejected"],
  );

  // 一覧から選んだときは、詳細の見出しへフォーカスを移す（キーボード・支援技術の利用者が詳細へ戻らずに済むようにする）。
  useEffect(() => heading.current?.focus(), []);
  // 審査後は操作がなくなるため、フォーカスを結果へ移す。
  useEffect(() => {
    if (done) result.current?.focus();
  }, [done]);
  useEffect(() => {
    if (alert) alertBox.current?.focus();
  }, [alert]);

  async function decide(decision: "approve" | "reject") {
    if (sending) return;
    const found = decision === "reject" ? reasonError(reason, "却下の理由") : null;
    setError(found);
    setAlert(null);
    if (found) return;
    setAction(decision);
    // 審査した版（表示した版番号）で確定する。表示後に本人が修正していれば409になる。
    const outcome = await submit({
      expectedVersion: review.version, decision, ...decision === "reject" ? { reason } : {},
    });
    setAction(null);
    if (!outcome) return;
    if (outcome.kind === "done") {
      setDone(outcome.state);
      router.refresh();
      return;
    }
    if (outcome.kind === "invalid") setError("却下の理由を確認してください。");
    setAlert(outcomeMessage(outcome.kind, "審査"));
  }

  const fields = review.profileFields;
  const status = done ?? review.status;

  return (
    <section className={styles.operationCard} aria-labelledby={`${id}-title`}>
      <p className={styles.badges}>
        <span className={statusBadges[status]}>{reviewStatusLabels[status]}</span>
      </p>
      <h2 id={`${id}-title`} ref={heading} className={styles.sectionTitle} tabIndex={-1}>{fields.displayName} の再公開申請</h2>
      {done ? <p ref={result} className={styles.success} role="status" tabIndex={-1}>{doneMessages[done]}</p> : null}

      <dl className={styles.details}>
        <div><dt>申請日時</dt><dd>{formatDateTime(review.submittedAt)}</dd></div>
        {review.decidedAt ? <div><dt>審査日時</dt><dd>{formatDateTime(review.decidedAt)}</dd></div> : null}
        {review.status === "rejected" && review.decisionReason
          ? <div><dt>却下の理由</dt><dd className={styles.multiline}>{review.decisionReason}</dd></div> : null}
      </dl>

      <h3 className={styles.subTitle}>{status === "pending" ? "公開される内容" : "申請の内容"}</h3>
      <dl className={styles.details}>
        <div><dt>公開表示名</dt><dd>{fields.displayName}</dd></div>
        <div><dt>学科</dt><dd>{fields.department ?? "未設定"}</dd></div>
        <div><dt>入学年度</dt><dd>{fields.entryYear ?? "未設定"}</dd></div>
        <div><dt>卒業年度</dt><dd>{fields.graduationYear ?? "未設定"}</dd></div>
        {optionalFieldOrder.map((field) => fields.optionalFields[field]?.value ? (
          <div key={field}>
            <dt>{optionalFieldLabels[field]}</dt>
            <dd className={styles.multiline}>{fields.optionalFields[field].value}</dd>
          </div>
        ) : null)}
      </dl>
      <p className={styles.help}>本人が公開範囲を「自分だけ」にした項目は表示されません。</p>

      {review.capabilities.canReview && !done ? (
        <form
          className={styles.form}
          aria-label="再公開の審査"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}
        >
          {alert ? (
            <div ref={alertBox} className={styles.formError} role="alert" tabIndex={-1}>
              <p>{alert.message}</p>
              {alert.reload ? (
                <button type="button" className={styles.secondaryButton} onClick={() => window.location.reload()}>
                  最新の内容を読み込む
                </button>
              ) : null}
            </div>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={styles.primaryButton} disabled={sending} onClick={() => decide("approve")}>
              {action === "approve" ? "承認中…" : "承認する"}
            </button>
          </div>
          <div className={styles.rejection}>
            <ReasonField
              id={`${id}-reason`} label="却下の理由" required="却下時は必須" help="本人に通知されます。"
              value={reason} error={error} disabled={sending} onChange={setReason}
            />
            <div className={styles.actions}>
              <button type="button" className={styles.dangerButton} disabled={sending} onClick={() => decide("reject")}>
                {action === "reject" ? "却下中…" : "却下する"}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <p className={styles.links}>
        <Link href={`/admin/users/${encodeURIComponent(review.userId)}`}>利用者の管理画面へ</Link>
        <Link href={closeHref}>一覧だけを表示する</Link>
      </p>
    </section>
  );
}
