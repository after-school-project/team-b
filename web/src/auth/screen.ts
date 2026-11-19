import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError } from "@/api/response";
import { resolveRequestAccess, type Viewer } from "./access";
import { loginPathFor } from "./return-to";

/** Next.js のページが受け取る `searchParams` を解決した値。 */
export type ScreenSearchParams = Record<string, string | string[] | undefined>;

function withQuery(path: string, searchParams: ScreenSearchParams = {}): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, item);
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * ログイン後の画面（Server Component）の入口。各ページの先頭で、そのページ自身のパスと
 * 解決済みの `searchParams` を渡して呼ぶ。再ログイン後の戻り先は `loginPathFor` の許可条件で絞る。
 *
 * - 未認証・失効：個人データを返さずログイン画面へ。戻り先は許可した相対パスだけを付ける。
 * - 発行・学校確認未完了、停止中：ログイン画面（同じ入口）へ。入口が `/me` で利用準備中・停止の案内とログアウトを表示する。
 * - 利用中：DBから読んだ最新の Viewer を返す。プロフィール状態・管理権限による制限は各画面で判定する。
 *
 * レイアウトはクライアント側の画面遷移で再実行されないため、判定はレイアウトではなくページごとに行う。
 */
export async function requireScreenViewer(currentPath: string, searchParams?: ScreenSearchParams): Promise<Viewer> {
  let access;
  try {
    access = await resolveRequestAccess(await headers());
  } catch (error) {
    if (error instanceof ApiError && error.code === "AUTH_REQUIRED") {
      redirect(loginPathFor(withQuery(currentPath, searchParams)));
    }
    if (error instanceof ApiError && error.code === "ACCOUNT_NOT_READY") redirect("/login");
    throw error;
  }
  if (access.state.access !== "active") redirect("/login");
  return access.state.viewer;
}
