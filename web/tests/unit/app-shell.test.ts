import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
/** true の間は、未実装の画面も含めて全導線を実装済みとして描画する（リンク・現在地・未読表示の確認用）。 */
const availability = vi.hoisted(() => ({ all: false }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

vi.mock("@/components/app-shell/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/navigation")>();
  return {
    ...actual,
    isNavItemAvailable: (item: { href: string }) => availability.all || actual.isNavItemAvailable(item),
  };
});

import { AppShell, type AppShellProps } from "@/components/app-shell/AppShell";
import {
  ACCOUNT_NAV_ITEMS,
  ADMIN_NAV_ITEM,
  ADMIN_REPORTS_NAV_ITEM,
  NOTIFICATION_NAV_ITEM,
  PRIMARY_NAV_ITEMS,
  formatUnreadCount,
  getAriaCurrent,
  isNavItemActive,
} from "@/components/app-shell/navigation";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/StateMessage";

/** 共通ナビの導線のうち、実装済みの画面（`implementedScreenRoutes`）。ほかは「準備中」として押せない状態にする。 */
const implementedNavHrefs = new Set([
  "/", "/questions", "/notices", "/events", "/alumni", "/me/profile", "/me/questions", "/me/notices", "/notifications",
]);

/** `viewerUnread` は `requireAppScreen` がサーバーで数えた件数、`unread` は開発用プレビューが渡す仮の件数。 */
function renderShell(options: { canAccessAdmin: boolean; pathname?: string; unread?: number; viewerUnread?: number }) {
  navigation.pathname = options.pathname ?? "/";
  const props: Omit<AppShellProps, "children"> = {
    viewer: {
      displayName: "架空 太郎", canAccessAdmin: options.canAccessAdmin, unreadNotificationCount: options.viewerUnread,
    },
    unreadNotificationCount: options.unread,
  };
  return renderToStaticMarkup(
    createElement(AppShell, props as AppShellProps, createElement("h1", null, "仮ページ")),
  );
}

describe("共通ナビゲーションの導線定義", () => {
  it("主要導線は設計書のURLで、ホーム・Q&A・お知らせ・イベント・卒業生検索の順に並ぶ", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => [item.label, item.href])).toEqual([
      ["ホーム", "/"],
      ["Q&A", "/questions"],
      ["お知らせ", "/notices"],
      ["イベント", "/events"],
      ["卒業生検索", "/alumni"],
    ]);
  });

  it("本人メニューにマイプロフィールを含む", () => {
    expect(ACCOUNT_NAV_ITEMS[0]).toMatchObject({ label: "マイプロフィール", href: "/me/profile" });
  });

  it.each([
    ["/", "/", true],
    ["/questions", "/", false],
    ["/questions", "/questions", true],
    ["/questions/abc", "/questions", true],
    ["/questions/", "/questions", true],
    ["/questions?q=test", "/questions", true],
    ["/questionsx", "/questions", false],
    ["/me/questions", "/questions", false],
    ["/notifications", "/notices", false],
  ])("%s は %s の導線として現在地=%s", (pathname, href, expected) => {
    expect(isNavItemActive(pathname, href)).toBe(expected);
  });

  it("対象画面は page、配下の画面は true を aria-current に設定する", () => {
    expect(getAriaCurrent("/questions", "/questions")).toBe("page");
    expect(getAriaCurrent("/questions/abc/edit", "/questions")).toBe("true");
    expect(getAriaCurrent("/events", "/questions")).toBeUndefined();
  });

  it.each([
    [undefined, null],
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [3, "3"],
    [99, "99"],
    [100, "99+"],
  ])("未読件数 %s の表示は %s", (count, expected) => {
    expect(formatUnreadCount(count)).toBe(expected);
  });
});

describe("導線の実装状況", () => {
  it("実装済みの画面の導線を押せる状態にする", async () => {
    const actual = await vi.importActual<typeof import("@/components/app-shell/navigation")>(
      "@/components/app-shell/navigation",
    );
    for (const item of [...PRIMARY_NAV_ITEMS, ...ACCOUNT_NAV_ITEMS, NOTIFICATION_NAV_ITEM, ADMIN_NAV_ITEM]) {
      expect(actual.isNavItemAvailable(item), item.href).toBe(implementedNavHrefs.has(item.href));
    }
    expect(actual.isNavItemAvailable(ADMIN_REPORTS_NAV_ITEM)).toBe(true);
  });
});

describe("AppShell（未実装の画面がある状態）", () => {
  beforeEach(() => {
    navigation.pathname = "/";
    availability.all = false;
  });

  it("実装済みの画面だけをリンクにし、未実装の画面は押せない「準備中」として表示する", () => {
    const html = renderShell({ canAccessAdmin: false });
    for (const href of implementedNavHrefs) expect(html).toContain(`href="${href}"`);
    for (const item of [...PRIMARY_NAV_ITEMS, ...ACCOUNT_NAV_ITEMS, NOTIFICATION_NAV_ITEM]) {
      if (implementedNavHrefs.has(item.href)) continue;
      expect(html).not.toContain(`href="${item.href}"`);
      expect(html).toContain(item.label.replaceAll("&", "&amp;"));
    }
    expect(html).toContain("準備中");
    expect(html).toContain("（</span>準備中<span");
  });

  it("管理ホームが未実装の間は、有効な管理者を通報案件へ案内する", () => {
    const admin = renderShell({ canAccessAdmin: true });
    expect(admin).toContain(ADMIN_NAV_ITEM.label);
    expect(admin).not.toContain('href="/admin"');
    expect(admin).toContain('href="/admin/reports"');

    expect(renderShell({ canAccessAdmin: false })).not.toContain(ADMIN_NAV_ITEM.label);
  });

  it("通知の導線に、サーバーで数えた未読件数（viewer の値）を表示する", () => {
    const html = renderShell({ canAccessAdmin: false, viewerUnread: 3 });
    expect(html).toMatch(/href="\/notifications"[^>]*><span>通知<\/span><span[^>]*><span aria-hidden="true">3<\/span>/);
    expect(html).toContain("（未読3件）");
    expect(renderShell({ canAccessAdmin: false, viewerUnread: 0 })).not.toContain("未読");
    expect(renderShell({ canAccessAdmin: false })).not.toContain("未読");
  });

  it("開発用プレビューが渡した未読件数は、viewer の値より優先する", () => {
    expect(renderShell({ canAccessAdmin: false, viewerUnread: 3, unread: 5 })).toContain("（未読5件）");
    expect(renderShell({ canAccessAdmin: false, viewerUnread: 3, unread: 0 })).not.toContain("未読");
  });
});

describe("AppShell（全画面を実装済みとした場合）", () => {
  beforeEach(() => {
    navigation.pathname = "/";
    availability.all = true;
  });

  it("本文への移動リンク、主要メニュー、通知、本人メニュー、本文を表示する", () => {
    const html = renderShell({ canAccessAdmin: false });

    expect(html).toContain('href="#main-content"');
    expect(html).toContain("本文へ移動");
    expect(html).toMatch(/<nav [^>]*aria-label="主要メニュー"/);
    expect(html).toContain('<main id="main-content"');
    expect(html).toContain("<h1>仮ページ</h1>");
    for (const item of [...PRIMARY_NAV_ITEMS, ...ACCOUNT_NAV_ITEMS]) {
      expect(html).toContain(`href="${item.href}"`);
    }
    expect(html).toContain('href="/notifications"');
    expect(html).toContain("架空 太郎");
  });

  it("管理権限がない場合は管理エリアへの導線を出力しない", () => {
    const html = renderShell({ canAccessAdmin: false });
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain("管理エリアへ");
  });

  it("有効な管理権限がある場合だけ管理エリアへの導線を表示する", () => {
    const html = renderShell({ canAccessAdmin: true });
    expect(html).toContain('href="/admin"');
    expect(html).toContain("管理エリアへ");
  });

  it("現在地の導線に aria-current を設定する", () => {
    const html = renderShell({ canAccessAdmin: false, pathname: "/questions" });
    expect(html).toMatch(/aria-current="page" href="\/questions"/);
    expect(html).not.toMatch(/aria-current="[^"]+" href="\/"/);
  });

  it("開閉ボタンは閉じた状態で aria-expanded と aria-controls を持つ", () => {
    const html = renderShell({ canAccessAdmin: false });
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*>メニュー</);
    expect(html).toMatch(/aria-expanded="false" aria-controls="[^"]+"[^>]*>マイメニュー/);
  });

  it("未読件数を数字と読み上げ用の文言で表示し、0件では表示しない", () => {
    expect(renderShell({ canAccessAdmin: false, unread: 3 })).toContain("（未読3件）");
    expect(renderShell({ canAccessAdmin: false, unread: 0 })).not.toContain("未読");
  });
});

describe("状態表示部品", () => {
  it("読み込み中は status として通知する", () => {
    const html = renderToStaticMarkup(createElement(LoadingState));
    expect(html).toContain('role="status"');
    expect(html).toContain("読み込み中…");
  });

  it("空状態は見出しと補足、操作を表示する", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "まだ質問はありません。",
        description: "補足",
        action: createElement("a", { href: "/questions/new" }, "質問を投稿"),
        headingLevel: 3,
      }),
    );
    expect(html).toContain("<h3");
    expect(html).toContain("まだ質問はありません。");
    expect(html).toContain('href="/questions/new"');
    expect(html).not.toContain('role="alert"');
  });

  it("共通エラーは alert として既定文言とエラーラベルを表示する", () => {
    const html = renderToStaticMarkup(createElement(ErrorState));
    expect(html).toContain('role="alert"');
    expect(html).toContain("エラー");
    expect(html).toContain("読み込めませんでした。もう一度お試しください。");
    expect(html).toContain("<h2");
  });
});
