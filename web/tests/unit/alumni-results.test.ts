import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlumniResults } from "@/app/alumni/alumni-results";
import type { PublicProfile } from "@/profile/public-profile";

/** 卒業生検索（GE-04）の結果表示（#8 ④）。 */
describe("卒業生検索の結果表示", () => {
  const profile: PublicProfile = {
    userId: "user-1", state: "public", baseRole: "alumni", isGraduating: false,
    fields: { displayName: "あおい", department: "IT学科（架空）", entryYear: null, graduationYear: 2026, optionalFields: {} },
    capabilities: { canReport: true },
  };
  const render = (props: { items?: PublicProfile[]; totalCount: number; continued?: boolean; nextPageHref?: string | null }) =>
    renderToStaticMarkup(createElement(AlumniResults, {
      items: props.items ?? [],
      page: { limit: 20, hasMore: Boolean(props.nextPageHref), nextCursor: null, totalCount: props.totalCount },
      continued: props.continued ?? false,
      firstPageHref: "/alumni?q=%E3%81%82",
      nextPageHref: props.nextPageHref ?? null,
    }));

  it("該当者がいなければ、0件の案内を表示する", () => {
    const html = render({ totalCount: 0 });
    expect(html).toContain("0件");
    expect(html).toContain("条件に合う卒業生・卒業予定者はいません。");
    expect(html).not.toContain("最初のページを表示");
  });

  it("ページ送りの途中で該当者が残ったまま続きが空になったら、「いません」とせず、条件を保って先頭へ戻る導線を示す", () => {
    const html = render({ totalCount: 1, continued: true });
    expect(html).toContain("1件");
    expect(html).not.toContain("条件に合う卒業生・卒業予定者はいません。");
    expect(html).toContain("検索結果が変わったため");
    expect(html).toContain('href="/alumni?q=%E3%81%82"');
  });

  it("ページ送りの途中で該当者がいなくなったら、0件の案内と先頭へ戻る導線を示す", () => {
    const html = render({ totalCount: 0, continued: true });
    expect(html).toContain("条件に合う卒業生・卒業予定者はいません。");
    expect(html).not.toContain("検索結果が変わったため");
    expect(html).toContain("最初のページを表示");
  });

  it("結果がある場合はプロフィールへのリンクと、次のページ・先頭のページへの導線を示す", () => {
    const html = render({ items: [profile], totalCount: 21, continued: true, nextPageHref: "/alumni?cursor=next" });
    expect(html).toContain('href="/users/user-1"');
    expect(html).toContain('href="/alumni?cursor=next"');
    expect(html).toContain("次の20件を表示");
    expect(html).toContain("最初のページを表示");
    expect(render({ items: [profile], totalCount: 1 })).not.toContain("最初のページを表示");
  });
});
