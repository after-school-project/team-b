import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell/AppShell";
import { requireAppScreen } from "@/components/app-shell/screen";
import type { ScreenSearchParams } from "@/auth/screen";
import { loadMyProfile } from "@/profile/my-profile";
import { ProfileEditor } from "./profile-editor";

export const metadata: Metadata = { title: "マイプロフィール" };

/** GE-02 マイプロフィール・編集。本人の公開情報・公開範囲・掲載希望・再公開申請を管理する。 */
export default async function MyProfilePage({ searchParams }: { searchParams: Promise<ScreenSearchParams> }) {
  const { viewer, shell } = await requireAppScreen("/me/profile", await searchParams);
  // DBクライアントは描画時に読み込む（ビルド時にDB接続情報を必要としない）。
  const { db } = await import("@/db/client");
  const profile = await loadMyProfile(db, viewer.userId);

  return (
    <AppShell viewer={shell}>
      <ProfileEditor profile={profile} />
    </AppShell>
  );
}
