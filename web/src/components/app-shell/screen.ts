import "server-only";
import { and, eq } from "drizzle-orm";
import { canEnterAdmin, type AccessReader, type Viewer } from "@/auth/access";
import { hasAdminScope, type AdminScope } from "@/auth/admin";
import { requireScreenViewer, type ScreenSearchParams } from "@/auth/screen";
import { profileRevisions, profiles } from "@/db/schema";
import { withSafeScreenErrors } from "@/db/screen-read";
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
  return { viewer, shell: await withSafeScreenErrors(() => loadAppShellViewer(viewer)) };
}

/**
 * 管理エリアの画面の判定結果。`denied` の場合、ページは管理データを読まずに `AdminAccessDenied` だけを表示する。
 * 判定結果を必ず分岐させるため、管理データの取得は `granted` の場合だけに書く。
 */
export type AdminScreen = AppScreen & { access: "granted" | "denied" };

/**
 * 管理エリアの画面（`/admin/*`）の共通の入口。`requireAppScreen` の判定の後に、管理APIと同じ区分で管理権限を確認する。
 *
 * - 未認証・利用準備中・停止中：`requireAppScreen` と同じ（ログイン画面へ）。
 * - 管理権限が足りない（一般利用者、権限解除・プロフィール非表示中のアプリ管理者、学校専用画面のアプリ管理者）：
 *   `denied`。ログインは維持し、権限変更の案内とホームへの導線を表示する（画面遷移・状態遷移設計書 §4）。
 * - サーバーでページを描画するたびに、DBから読んだ最新の状態で判定する。権限の解除・停止は、次にサーバーで
 *   ページを描画したとき（画面遷移・再読込）から反映される。表示済みの画面と、ブラウザーの戻る・進むで
 *   クライアントのキャッシュから再表示した画面は、次の描画まで残る。管理データの取得・更新は、
 *   管理API（`defineAdminApiRoute`）が要求ごとに最新の状態で判定して拒否する。
 *
 * 対象者によって学校専用になる操作や、操作ごとの条件は、各画面・APIで判定する。
 */
export async function requireAdminScreen(
  scope: AdminScope,
  currentPath: string,
  searchParams?: ScreenSearchParams,
): Promise<AdminScreen> {
  const screen = await requireAppScreen(currentPath, searchParams);
  return { ...screen, access: hasAdminScope(screen.viewer, scope) ? "granted" : "denied" };
}
