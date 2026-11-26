import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { containing } from "../../src/api/list-filters";
import { noCapabilities } from "../../src/auth/capabilities";
import {
  ManagedNoticeDetail, MyNoticeFilter, NoticeRequests, NoticeResults, NoticeSearchForm, PublicNoticeDetail,
} from "../../src/app/notices/components";
import {
  createNoticeInput, parseMyNoticeQuery, parsePublicNoticeQuery, parseRequestQuery,
  type ManagedContent, type NoticeListItem, type PublicNotice,
} from "../../src/notices/notices";

const noticeId = "0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21";

describe("お知らせAPI入力", () => {
  it("仮カテゴリーだけを受け付け、タイトル・本文の境界と正規化を適用する", () => {
    expect(createNoticeInput.parse({
      title: "  お知らせ  ", body: "本文\r\n続き", categoryCode: "general",
    })).toEqual({ title: "お知らせ", body: "本文\n続き", categoryCode: "general" });
    expect(createNoticeInput.safeParse({ title: "", body: "本文", categoryCode: "general" }).success).toBe(false);
    expect(createNoticeInput.safeParse({ title: "題名", body: "本文", categoryCode: "other" }).success).toBe(false);
    expect(createNoticeInput.safeParse({
      title: "題名", body: "本文", categoryCode: "general", authorId: "forged",
    }).success).toBe(false);
  });

  it("検索条件を正規化し、一覧ごとに許可したクエリーだけを受け付ける", () => {
    expect(parsePublicNoticeQuery(new URL("https://example.test/?q=%20React%20&limit=5"))).toEqual({
      q: "React", limit: 5, cursor: undefined,
    });
    expect(parsePublicNoticeQuery(new URL("https://example.test/"))).toEqual({ limit: 20 });
    expect(parseMyNoticeQuery(new URL("https://example.test/?state=deleted&sort=updated_desc"))).toMatchObject({
      state: "deleted", sort: "updated_desc", limit: 20,
    });
    expect(parseRequestQuery(new URL("https://example.test/?limit=1"))).toMatchObject({ limit: 1 });
    expect(() => parseMyNoticeQuery(new URL("https://example.test/?q=private"))).toThrow();
    expect(() => parseRequestQuery(new URL("https://example.test/?state=pending"))).toThrow();
  });

  it("キーワード検索でLIKEのワイルドカードを文字として扱う", () => {
    expect(containing("100%_\\")).toBe("%100\\%\\_\\\\%");
  });
});

describe("お知らせ画面", () => {
  const item: NoticeListItem = {
    id: noticeId, title: "<b>題名</b>", category: { code: "general", name: "お知らせ（仮）" },
    originKind: "alumni", author: { userId: "author-1", displayName: "あおい" },
    firstPublishedAt: "2026-11-20T15:30:00.000Z", updatedAt: "2026-11-21T00:00:00.000Z",
  };
  const publicNotice: PublicNotice = {
    id: noticeId, content: { title: "<img src=x>", body: "<script>alert(1)</script>", categoryCode: "general" },
    category: item.category, originKind: "alumni", author: item.author,
    firstPublishedAt: item.firstPublishedAt, updatedAt: item.updatedAt,
  };
  const managed: ManagedContent = {
    id: noticeId, version: 3, originKind: "alumni", author: item.author, publicationState: "hidden",
    publicContent: { title: "非表示題名", body: "本人用本文", categoryCode: "general" },
    pendingRequest: null, deletedContent: null, deletedAt: null, retentionExpiresAt: null,
    capabilities: { ...noCapabilities, canDelete: true },
  };

  it("一覧に本文を出さず、検索欄・件数・ページ導線を正しく表示する", () => {
    const form = renderToStaticMarkup(createElement(NoticeSearchForm, { q: "行事" }));
    expect(form).toContain('for="notice-q"');
    expect(form).toContain('value="行事"');
    const html = renderToStaticMarkup(createElement(NoticeResults, {
      items: [item],
      page: { limit: 20, hasMore: true, nextCursor: "cursor", totalCount: 21 },
      filtered: true, continued: false, firstPageHref: "/notices?q=x", nextPageHref: "/notices?q=x&cursor=cursor",
    }));
    expect(html).toContain("21件");
    expect(html).toContain("&lt;b&gt;題名&lt;/b&gt;");
    expect(html).toContain("次の20件を表示");
    expect(html).not.toContain("本文");
  });

  it("プレーンテキストをHTMLとして実行せず、非表示・本人状態を明示する", () => {
    const publicHtml = renderToStaticMarkup(createElement(PublicNoticeDetail, { notice: publicNotice }));
    expect(publicHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(publicHtml).not.toContain("<script>");
    const managedHtml = renderToStaticMarkup(createElement(ManagedNoticeDetail, { notice: managed }));
    expect(managedHtml).toContain("管理者により非表示");
    expect(managedHtml).toContain("本人用本文");
  });

  it("本人一覧の状態・並び替えと独立した申請詳細へのリンクを示す", () => {
    const filter = renderToStaticMarkup(createElement(MyNoticeFilter, { state: "pending", sort: "updated_desc" }));
    expect(filter).toContain('<option value="pending" selected="">審査中</option>');
    expect(filter).toContain('<option value="updated_desc" selected="">更新日時の新しい順</option>');
    const history = renderToStaticMarkup(createElement(NoticeRequests, {
      noticeId,
      requestCursor: "previous",
      nextPageHref: `/me/notices?notice=${noticeId}&requestCursor=cursor`,
      items: [{
        id: "request-1", resourceId: noticeId, kind: "edit", status: "withdrawn", submittedAt: item.updatedAt,
        decidedAt: null, version: 2, needsDateCorrection: false,
      }],
    }));
    expect(history).toContain(`href="/me/notices?notice=${noticeId}&amp;request=request-1&amp;requestCursor=previous"`);
    expect(history).toContain("取り下げ済み");
    expect(history).toContain("申請履歴の続きを表示");
  });
});
