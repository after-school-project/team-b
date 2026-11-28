import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { userId as userIdSchema } from "@/api/request";
import { ApiError } from "@/api/response";
import type { ScreenSearchParams } from "@/auth/screen";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import { ReportButton } from "@/components/report/ReportButton";
import { readForScreen } from "@/db/screen-read";
import { loadUserProfile, type HiddenProfile, type PublicProfile } from "@/profile/public-profile";
import { findReportableUser } from "@/reports/target-access";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "プロフィール" };

const baseRoleLabels: Record<PublicProfile["baseRole"], string> = { student: "在校生", alumni: "卒業生", staff: "学校職員" };
const optionalFieldLabels = { bio: "自己紹介", occupation: "職種", interests: "関心分野" } as const;
const optionalFieldOrder = ["bio", "occupation", "interests"] as const;

/** GE-03 ユーザープロフィール詳細。公開を許可された項目だけを表示し、非表示中は状態案内だけを表示する。 */
export default async function UserProfilePage({ params, searchParams }: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<ScreenSearchParams>;
}) {
  const { userId } = await params;
  const { viewer, shell } = await requireAppScreen(`/users/${encodeURIComponent(userId)}`, await searchParams);
  if (!userIdSchema.safeParse(userId).success) notFound();

  let profile: PublicProfile | HiddenProfile;
  let canReportAccount: boolean;
  try {
    ({ profile, canReportAccount } = await readForScreen(async (db) => {
      const profile = await loadUserProfile(db, viewer, userId);
      const canReportAccount = profile.state === "public" ? profile.capabilities.canReport
        : Boolean(await findReportableUser(db, viewer.userId, userId, false));
      return { profile, canReportAccount };
    }));
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  const own = profile.userId === viewer.userId;

  return (
    <AppShell viewer={shell}>
      <div className={styles.page}>
        <p className={styles.back}><Link href="/alumni">卒業生検索へ</Link></p>
        {profile.state === "hidden" ? (
          <>
            <h1 className={styles.title}>プロフィール</h1>
            <section className={styles.notice}>
              <span className={styles.badgeNeutral}>非表示</span>
              <p>このプロフィールは現在表示できません。</p>
            </section>
          </>
        ) : (
          <>
            <header className={styles.header}>
              <h1 className={styles.title}>{profile.fields.displayName}</h1>
              <p className={styles.badges}>
                <span className={styles.badgeInfo}>{baseRoleLabels[profile.baseRole]}</span>
                {profile.isGraduating ? <span className={styles.badgeInfo}>卒業予定</span> : null}
              </p>
            </header>

            <section className={styles.card} aria-labelledby="affiliation">
              <h2 id="affiliation" className={styles.sectionTitle}>所属</h2>
              <dl className={styles.details}>
                {profile.fields.department ? <div><dt>学科</dt><dd>{profile.fields.department}</dd></div> : null}
                {profile.fields.entryYear ? <div><dt>入学年度</dt><dd>{profile.fields.entryYear}</dd></div> : null}
                {profile.fields.graduationYear
                  ? <div><dt>卒業年度</dt><dd>{profile.fields.graduationYear}</dd></div> : null}
                {!profile.fields.department && !profile.fields.entryYear && !profile.fields.graduationYear
                  ? <div><dt>学科・年度</dt><dd>登録されていません</dd></div> : null}
              </dl>
            </section>

            <section className={styles.card} aria-labelledby="introduction">
              <h2 id="introduction" className={styles.sectionTitle}>自己紹介など</h2>
              {optionalFieldOrder.some((field) => profile.fields.optionalFields[field]?.value) ? (
                <dl className={styles.details}>
                  {optionalFieldOrder.map((field) => {
                    const value = profile.fields.optionalFields[field]?.value;
                    return value ? (
                      <div key={field}>
                        <dt>{optionalFieldLabels[field]}</dt>
                        <dd className={field === "bio" ? styles.multiline : undefined}>{value}</dd>
                      </div>
                    ) : null;
                  })}
                </dl>
              ) : (
                <p className={styles.empty}>公開されている項目はありません。</p>
              )}
            </section>
          </>
        )}

        {canReportAccount ? (
          <div className={styles.reportActions}>
            {profile.state === "public" ? <ReportButton type="profile" id={profile.userId} label={profile.fields.displayName} /> : null}
            <ReportButton type="account" id={profile.userId}
              label={profile.state === "public" ? profile.fields.displayName : profile.userId} />
          </div>
        ) : null}
        {own ? (
          <section className={styles.ownNotice}>
            <p>
              {profile.state === "public"
                ? "あなたのプロフィールです。ほかの利用者には、この内容が表示されます。"
                : "あなたのプロフィールです。非表示の間は、ほかの利用者に内容は表示されません。"}
            </p>
            <Link className={styles.secondaryLink} href="/me/profile">マイプロフィールを編集</Link>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
