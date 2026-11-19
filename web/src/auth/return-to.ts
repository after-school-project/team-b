/**
 * ログイン後の戻り先（returnTo）の許可条件。
 * ログイン画面（#34）と、未認証アクセスをログイン画面へ送る共通認可（#7）で同じ条件を使う。
 * 遷移先の権限はここでは判定せず、遷移先のサーバー処理で最新の利用資格と合わせて確認する。
 */

const appOrigin = "https://after-school.invalid";
const defaultReturnTo = "/";

/**
 * 戻り先として許可する実装済み画面のパス。
 * 画面を実装したら追加する（`components/app-shell/navigation.ts` の導線でも、未実装の画面は含めない）。
 * `/login` と `/api/*` は追加しない。
 */
const allowedReturnPaths: ReadonlySet<string> = new Set(["/"]);

/** 許可した同一アプリ内の相対パスだけを返す。未指定・許可外は `/`。 */
export function resolveReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return defaultReturnTo;
  }

  try {
    const destination = new URL(value, appOrigin);
    if (
      destination.origin !== appOrigin ||
      destination.pathname === "/login" ||
      destination.pathname.startsWith("/api/") ||
      !allowedReturnPaths.has(destination.pathname)
    ) {
      return defaultReturnTo;
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return defaultReturnTo;
  }
}

/** 戻り先を付けたログイン画面のURL。許可外の戻り先は付けない。 */
export function loginPathFor(returnTo: unknown): string {
  const resolved = resolveReturnTo(returnTo);
  return resolved === defaultReturnTo ? "/login" : `/login?returnTo=${encodeURIComponent(resolved)}`;
}
