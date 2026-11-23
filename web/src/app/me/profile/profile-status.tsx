import type { MyProfile } from "@/profile/my-profile";
import styles from "./page.module.css";

const decisionLabels = { approved: "承認済み", rejected: "却下" } as const;

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" })
    .format(new Date(value));
}

/**
 * マイプロフィールの公開状態と再公開申請の表示（GE-02）。
 *
 * 現在の公開状態と、再公開申請の結果は別の情報として表示する（docs/DESIGN.md §10）。
 * - 審査中の申請は「審査中の申請」として承認待ちと申請日時を示す。
 * - 確定した申請は、公開中・非表示中のどちらでも「前回の審査結果」として結果と審査日時を示す。
 *   承認で公開に戻った直後に承認結果を確認でき、その後再び非表示になっても、過去の承認を現在の申請と誤解させない。
 */
export function ProfileStatus({ profile, headingId }: { profile: MyProfile; headingId: string }) {
  const hidden = profile.profileState === "hidden";
  const review = profile.review;
  const pending = review?.status === "pending" ? review : null;
  const decided = review && review.status !== "pending" ? { ...review, status: review.status } : null;

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>公開状態</h2>
      <p className={styles.stateRow}>
        <span className={hidden ? styles.badgeWarning : styles.badgeSuccess}>{hidden ? "非表示" : "公開中"}</span>
        {hidden
          ? "プロフィールは管理者により非表示になっています。ほかの利用者には表示されません。"
          : "ほかの利用者に、公開を許可した項目が表示されます。"}
      </p>

      {hidden || review ? (
        <div className={hidden ? styles.reviewBox : styles.reviewHistory}>
          <h3 className={styles.subTitle}>再公開の申請</h3>
          {pending ? (
            <dl className={styles.details}>
              <div>
                <dt>審査中の申請</dt>
                <dd><span className={styles.badgeWarning}>承認待ち</span></dd>
              </div>
              <div>
                <dt>申請日時</dt>
                <dd>{formatDateTime(pending.submittedAt)}</dd>
              </div>
            </dl>
          ) : hidden ? (
            <p className={styles.reviewText}>
              審査中の申請はありません。内容を修正して保存すると、再公開の申請として管理者が審査します。
            </p>
          ) : null}
          {pending && hidden ? (
            <p className={styles.reviewText}>審査中も内容を修正できます。保存すると、審査する内容が最新の内容に変わります。</p>
          ) : null}

          {decided ? (
            <dl className={styles.details} aria-label="前回の審査結果">
              <div>
                <dt>前回の審査結果</dt>
                <dd>
                  <span className={decided.status === "approved" ? styles.badgeSuccess : styles.badgeDanger}>
                    {decisionLabels[decided.status]}
                  </span>
                </dd>
              </div>
              {decided.decidedAt ? (
                <div>
                  <dt>審査日時</dt>
                  <dd>{formatDateTime(decided.decidedAt)}</dd>
                </div>
              ) : null}
              {decided.status === "rejected" && decided.decisionReason ? (
                <div>
                  <dt>却下の理由</dt>
                  <dd className={styles.reason}>{decided.decisionReason}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
