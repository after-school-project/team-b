import { matchesScreenRoute } from "@/auth/return-to";

/**
 * ログイン後の共通ナビゲーション（SCR-01）の導線定義。
 * URLは画面遷移・状態遷移設計書 §2 に従う。表示可否はサーバーで判定した値（AppShellViewer）だけで切り替える。
 */

export type NavItem = {
  /** 画面ID。設計書との対応を追跡するために保持する。 */
  screenId: string;
  label: string;
  href: string;
};

/** 主要導線：ホーム／Q&A／お知らせ／イベント／卒業生検索（画面一覧設計書 §4）。 */
export const PRIMARY_NAV_ITEMS: readonly NavItem[] = [
  { screenId: "GE-01", label: "ホーム", href: "/" },
  { screenId: "QA-01", label: "Q&A", href: "/questions" },
  { screenId: "NO-01", label: "お知らせ", href: "/notices" },
  { screenId: "EV-01", label: "イベント", href: "/events" },
  { screenId: "GE-04", label: "卒業生検索", href: "/alumni" },
];

/** ヘッダーの通知導線（GE-06）。 */
export const NOTIFICATION_NAV_ITEM: NavItem = {
  screenId: "GE-06",
  label: "通知",
  href: "/notifications",
};

/** 本人メニュー（GE-02、GE-05、NO-04、EV-04）。 */
export const ACCOUNT_NAV_ITEMS: readonly NavItem[] = [
  { screenId: "GE-02", label: "マイプロフィール", href: "/me/profile" },
  { screenId: "GE-05", label: "自分のQ&A", href: "/me/questions" },
  { screenId: "NO-04", label: "自分のお知らせ", href: "/me/notices" },
  { screenId: "EV-04", label: "自分のイベント", href: "/me/events" },
];

/** 管理エリアへの導線（AD-01）。有効な管理権限がある場合だけ表示する。 */
export const ADMIN_NAV_ITEM: NavItem = {
  screenId: "AD-01",
  label: "管理エリアへ",
  href: "/admin",
};

/** 共通レイアウトに渡す、サーバーで判定済みの閲覧者情報。 */
export type AppShellViewer = {
  /** 公開表示名。 */
  displayName: string;
  /** 現在有効な管理権限（学校管理者・アプリ管理者）があり、管理機能を利用できるか。 */
  canAccessAdmin: boolean;
  /** 本人宛ての通知の未読件数（API-NT-02 と同じ条件）。未指定・0件はバッジを表示しない。 */
  unreadNotificationCount?: number;
};

/**
 * 現在のパスが導線の対象画面（配下を含む）か判定する。
 * ホーム（`/`）は完全一致のみ。それ以外はパスのセグメント境界で前方一致させ、`/questionsX` や `/me/questions` を誤判定しない。
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  const path = normalizePath(pathname);
  if (href === "/") {
    return path === "/";
  }
  return path === href || path.startsWith(`${href}/`);
}

/**
 * 導線に設定する `aria-current` の値。対象画面そのものなら "page"、配下の画面（詳細・編集など）なら "true"。
 */
export function getAriaCurrent(pathname: string, href: string): "page" | "true" | undefined {
  if (!isNavItemActive(pathname, href)) {
    return undefined;
  }
  return normalizePath(pathname) === href ? "page" : "true";
}

/**
 * 導線の画面が実装済みで、押せる状態にするか。戻り先の許可と同じ「実装済みの画面」の一覧（`auth/return-to.ts`）で判定する。
 * 未実装の画面は、導線の位置を保ったまま「準備中」として押せない状態で表示する。
 */
export function isNavItemAvailable(item: Pick<NavItem, "href">): boolean {
  return matchesScreenRoute(item.href);
}

/** 未読件数の表示用ラベル。0件・不明の場合は表示しない。 */
export function formatUnreadCount(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(Math.floor(count));
}

function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] ?? "";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.replace(/\/+$/, "") || "/";
  }
  return withoutQuery || "/";
}
