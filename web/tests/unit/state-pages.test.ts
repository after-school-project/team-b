import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";

describe("存在しないページの画面", () => {
  const html = renderToStaticMarkup(createElement(NotFound));

  it("日本語の見出しと案内、ホームへの導線を表示する", () => {
    expect(html).toMatch(/<main[^>]*>.*<h1[^>]*>ページが見つかりません<\/h1>/);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>ホームへ戻る<\/a>/);
  });

  it("対象が存在するかを示さない", () => {
    for (const word of ["削除", "非公開", "権限", "利用者"]) expect(html).not.toContain(word);
  });
});

describe("想定外の失敗の画面", () => {
  const html = renderToStaticMarkup(createElement(ErrorPage, { error: new Error("internal-detail"), retry: vi.fn() }));

  it("支援技術にも伝わる案内と、再読み込み・ホームへの導線を表示する", () => {
    expect(html).toMatch(/<main[^>]*>.*<h1[^>]*>画面を表示できません<\/h1>/);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*>もう一度読み込む<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>ホームへ戻る<\/a>/);
  });

  it("例外の内容を表示しない", () => {
    expect(html).not.toContain("internal-detail");
  });
});
