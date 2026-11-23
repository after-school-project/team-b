import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAccessDenied } from "@/components/app-shell/AdminAccessDenied";

/** 管理エリアの画面を、管理権限が足りない利用者が開いた場合の表示（#7 AC-08 の画面部分）。 */
describe("AdminAccessDenied", () => {
  const html = renderToStaticMarkup(createElement(AdminAccessDenied));

  it("見出しと、権限がないことを支援技術にも伝える案内を表示する", () => {
    expect(html).toMatch(/<h1[^>]*>管理エリア<\/h1>/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("この画面を利用する権限がありません。");
    expect(html).toContain("権限が変更された可能性があります");
  });

  it("一般ホームへの導線を表示する", () => {
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>ホームへ戻る<\/a>/);
  });

  it("どの権限が足りないかを示さない", () => {
    for (const word of ["学校管理者", "アプリ管理者", "学校専用"]) expect(html).not.toContain(word);
  });
});
