/**
 * ログイン後の戻り先（returnTo）の許可条件。
 * ログイン画面（#34）と、未認証アクセスをログイン画面へ送る共通認可（#7）で同じ条件を使う。
 * 遷移先の権限はここでは判定せず、遷移先のサーバー処理で最新の利用資格と合わせて確認する。
 */

const appOrigin = "https://after-school.invalid";
const defaultReturnTo = "/";

const uuidSegment = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userIdSegment = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 可変パスのパラメーターが受け付ける値。名前は画面遷移・状態遷移設計書 §2 のURLに合わせる。
 * 1つのパスセグメントだけに一致させ、`/`・`%`・`.` を含む値は受け付けない。
 */
const routeParams: Readonly<Record<string, RegExp>> = {
  questionId: uuidSegment,
  eventId: uuidSegment,
  noticeId: uuidSegment,
  caseId: uuidSegment,
  userId: userIdSegment,
};

/**
 * 実装済みの画面のルート。戻り先の許可と、共通ナビで押せる導線の判定（`components/app-shell/navigation.ts`）に使う。
 * 可変部分は `/questions/[questionId]` のように書く。画面を実装したら追加し、未実装の画面は含めない。
 * `/login` と `/api/*` は追加しない。
 */
export const implementedScreenRoutes: readonly string[] = [
  "/", "/me/profile", "/users/[userId]", "/alumni", "/questions", "/questions/[questionId]",
  "/questions/new", "/questions/[questionId]/edit", "/me/questions",
  "/events",
  "/notices", "/notices/[noticeId]", "/notices/new", "/me/notices", "/me/notices/[noticeId]/edit",
  "/admin/users/[userId]", "/admin/profile-reviews", "/admin/graduation", "/admin/notices", "/admin/notices/[noticeId]",
  "/notifications",
];

type CompiledRoute = readonly (string | RegExp)[];

function compileRoute(route: string): CompiledRoute {
  if (!route.startsWith("/")) throw new Error(`画面のルートは / で始めてください: ${route}`);
  return route === "/" ? [] : route.slice(1).split("/").map((segment) => {
    // 角括弧を含むセグメントは必ずパラメーターとして扱い、`[question_id]` のような誤記を固定パスとして通さない。
    if (!segment.includes("[") && !segment.includes("]")) return segment;
    const param = /^\[([^[\]]+)\]$/.exec(segment)?.[1];
    const pattern = param === undefined || !Object.hasOwn(routeParams, param) ? undefined : routeParams[param];
    if (!pattern) throw new Error(`未定義のルートパラメーターです: ${segment}`);
    return pattern;
  });
}

function matchesCompiled(pathname: string, route: CompiledRoute): boolean {
  const segments = pathname === "/" ? [] : pathname.slice(1).split("/");
  return segments.length === route.length &&
    route.every((part, index) => typeof part === "string" ? segments[index] === part : part.test(segments[index] ?? ""));
}

const compiledRoutes = new Map<readonly string[], readonly CompiledRoute[]>();

function compiledFor(routes: readonly string[]): readonly CompiledRoute[] {
  let compiled = compiledRoutes.get(routes);
  if (!compiled) {
    compiled = routes.map(compileRoute);
    compiledRoutes.set(routes, compiled);
  }
  return compiled;
}

// 一覧の誤記（未定義のパラメーター名など）は、読み込み時（ビルド・テスト）に設定エラーとして止める。
compiledFor(implementedScreenRoutes);

/** パス（クエリー・ハッシュを含まない）が実装済みの画面のルートに一致するか。 */
export function matchesScreenRoute(pathname: string, routes: readonly string[] = implementedScreenRoutes): boolean {
  return compiledFor(routes).some((route) => matchesCompiled(pathname, route));
}

/** 許可した同一アプリ内の相対パスだけを返す。未指定・許可外は `/`。 */
export function resolveReturnTo(value: unknown, routes: readonly string[] = implementedScreenRoutes): string {
  // ルート定義の誤りは、下の URL 解析の失敗（利用者の入力の誤り）と区別し、吸収せずに投げる。
  compiledFor(routes);
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return defaultReturnTo;
  }

  try {
    const destination = new URL(value, appOrigin);
    if (
      destination.origin !== appOrigin ||
      destination.pathname === "/login" ||
      destination.pathname.startsWith("/api/") ||
      !matchesScreenRoute(destination.pathname, routes)
    ) {
      return defaultReturnTo;
    }

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return defaultReturnTo;
  }
}

/** 戻り先を付けたログイン画面のURL。許可外の戻り先は付けない。 */
export function loginPathFor(returnTo: unknown, routes: readonly string[] = implementedScreenRoutes): string {
  const resolved = resolveReturnTo(returnTo, routes);
  return resolved === defaultReturnTo ? "/login" : `/login?returnTo=${encodeURIComponent(resolved)}`;
}
