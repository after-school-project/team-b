import "server-only";
import { and, eq } from "drizzle-orm";
import { canEnterAdmin, type AccessReader, type Viewer } from "@/auth/access";
import { requireScreenViewer, type ScreenSearchParams } from "@/auth/screen";
import { profileRevisions, profiles } from "@/db/schema";
import type { AppShellViewer } from "./navigation";

async function defaultReader(): Promise<AccessReader> {
  return (await import("@/db/client")).db;
}

/**
 * 共通レイアウトに渡す閲覧者情報を、サーバーで読んだ最新の状態から作る。
 * 表示名は本人プロフィールの現在版。管理導線は管理エリアの入口条件（`canEnterAdmin`）と同じ条件で出す。
 */
export async function loadAppShellViewer(viewer: Viewer, reader?: AccessReader): Promise<AppShellViewer> {
  const database = reader ?? await defaultReader();
  const [profile] = await database.select({ displayName: profileRevisions.displayName })
    .from(profiles)
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId),
      eq(profileRevisions.userId, profiles.userId),
    ))
    .where(eq(profiles.userId, viewer.userId));
  // 発行コマンドはプロフィールの現在版まで作ってから利用可能にするため、利用中の利用者には必ずある。
  if (!profile) throw new Error("利用中の利用者のプロフィールが見つかりません。");
  return { displayName: profile.displayName, canAccessAdmin: canEnterAdmin(viewer) };
}

export type AppScreen = {
  /** 業務の判定に使う最新の利用状態。 */
  viewer: Viewer;
  /** `AppShell` に渡す表示用の閲覧者情報。 */
  shell: AppShellViewer;
};

/**
 * ログイン後の画面の共通の入口。各ページの先頭で、そのページ自身のパスと解決済みの `searchParams` を渡して呼び、
 * 返された `shell` を `AppShell` に渡す。未認証・利用準備中・停止中の扱いは `requireScreenViewer` と同じ。
 */
export async function requireAppScreen(currentPath: string, searchParams?: ScreenSearchParams): Promise<AppScreen> {
  const viewer = await requireScreenViewer(currentPath, searchParams);
  return { viewer, shell: await loadAppShellViewer(viewer) };
}
