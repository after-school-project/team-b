import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QuestionDetail } from "@/app/questions/[questionId]/question-detail";
import { hasQuestionFilter, keywordError, readQuestionParams, type QuestionFilterValues } from "@/app/questions/question-filters";
import { QuestionResults } from "@/app/questions/question-results";
import { QuestionSearchForm } from "@/app/questions/question-search-form";
import { noCapabilities } from "@/auth/capabilities";
import type { QuestionListItem, QuestionView } from "@/qa/questions";

vi.mock("server-only", () => ({}));

/** Q&A一覧・検索（QA-01）と質問の詳細（QA-02）の表示（#9 ①③）。 */
describe("Q&A一覧の条件", () => {
  it("空欄は指定なしとし、同名の複数指定は形式の誤りとして扱う", () => {
    const { values, query, malformed } = readQuestionParams({ q: " ", category: "career", resolution: "", cursor: "c", other: "x" });
    expect(values).toEqual({ q: " ", category: "career", resolution: "" });
    expect(query.toString()).toBe("category=career&cursor=c");
    expect(malformed).toBe(false);
    expect(readQuestionParams({ q: ["a", "b"] }).malformed).toBe(true);
  });

  it("「すべて」と空欄は、条件の指定として扱わない", () => {
    for (const values of [{}, { q: " ", category: "", resolution: "all" }] as QuestionFilterValues[]) expect(hasQuestionFilter(values)).toBe(false);
    for (const values of [{ q: "a" }, { category: "chat" }, { resolution: "open" }] as QuestionFilterValues[]) {
      expect(hasQuestionFilter(values)).toBe(true);
    }
  });

  it("キーワードはAPIと同じくコードポイントの100文字まで受け付ける", () => {
    for (const value of [undefined, "", "  ", ` ${"𠮷".repeat(100)} `]) expect(keywordError(value)).toBeUndefined();
    expect(keywordError("𠮷".repeat(101))).toBe("キーワードは100文字以内で入力してください。");
    expect(keywordError("NUL\0")).toBe("キーワードに使えない文字が含まれています。");
  });
});

describe("Q&A一覧の検索フォーム", () => {
  const categories = [{ code: "career", name: "就職・キャリア" }, { code: "chat", name: "雑談" }];
  const render = (values: QuestionFilterValues) =>
    renderToStaticMarkup(createElement(QuestionSearchForm, { categories, values, keywordError: keywordError(values.q) }));

  it("適用中の条件を選択した状態にし、入力欄に見出しを関連付ける", () => {
    const html = render({ q: "就活", category: "chat", resolution: "open" });
    expect(html).toContain('value="就活"');
    expect(html).toContain('<option value="chat" selected="">雑談</option>');
    expect(html).toContain('<option value="open" selected="">未解決</option>');
    for (const id of ["question-q", "question-category", "question-resolution"]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain('role="alert"');
    expect(render({})).toContain('<option value="all" selected="">すべて</option>');
  });

  it("キーワードの誤りを欄の近くとフォーム上部で案内し、入力した内容を保つ", () => {
    const html = render({ q: "あ".repeat(101) });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="question-q-error question-q-help"');
    expect(html).toContain("検索条件を確認してください。（1件）");
    expect(html).toContain(`value="${"あ".repeat(101)}"`);
  });
});

describe("Q&A一覧の結果", () => {
  const item: QuestionListItem = {
    id: "0b6f2c1e-5d4a-4c3b-9a8f-7e6d5c4b3a21", title: "<b>題名</b>", category: { code: "chat", name: "雑談" },
    author: { userId: "user-1", displayName: "はる" }, resolution: "open", responseCount: 3,
    createdAt: "2026-11-20T15:30:00.000Z", updatedAt: "2026-11-20T15:30:00.000Z",
  };
  const render = (props: { items?: QuestionListItem[]; totalCount: number; filtered?: boolean; continued?: boolean; nextPageHref?: string | null }) =>
    renderToStaticMarkup(createElement(QuestionResults, {
      items: props.items ?? [],
      page: { limit: 20, hasMore: Boolean(props.nextPageHref), nextCursor: null, totalCount: props.totalCount },
      filtered: props.filtered ?? false, continued: props.continued ?? false,
      firstPageHref: "/questions?category=chat", nextPageHref: props.nextPageHref ?? null,
    }));

  it("カテゴリー・状態のラベル・題名・投稿者・日本時間の日時・件数を表示する", () => {
    const html = render({ items: [item], totalCount: 1 });
    for (const text of ["雑談", "未解決", "&lt;b&gt;題名&lt;/b&gt;", "はる", "2026/11/21 0:30", "回答・コメント 3件", `href="/questions/${item.id}"`]) {
      expect(html).toContain(text);
    }
    expect(render({ items: [{ ...item, resolution: "resolved" }], totalCount: 1 })).toContain("解決済み");
  });

  it("0件の案内を、条件の有無とページ送りの途中かどうかで分ける", () => {
    expect(render({ totalCount: 0 })).toContain("まだ質問はありません。");
    expect(render({ totalCount: 0, filtered: true })).toContain("条件に合う質問はありません。");
    const changed = render({ totalCount: 2, continued: true });
    expect(changed).toContain("一覧が変わったため");
    expect(changed).toContain('href="/questions?category=chat"');
    expect(changed).not.toContain("まだ質問はありません。");
  });

  it("次のページと最初のページへの導線を、必要なときだけ表示する", () => {
    const html = render({ items: [item], totalCount: 41, continued: true, nextPageHref: "/questions?cursor=next" });
    expect(html).toContain("次の20件を表示");
    expect(html).toContain("最初のページを表示");
    expect(render({ items: [item], totalCount: 1 })).not.toContain("のページを表示");
  });
});

describe("質問の詳細", () => {
  const shown: QuestionView = {
    id: "q", publicationState: "public", content: { title: "題名", bodyMarkdown: "# 見出し\n\n**強調** <b>生HTML</b>", category: { code: "chat", name: "雑談" } },
    author: { userId: "a b", displayName: "はる" }, resolution: "resolved", version: 1,
    createdAt: "2026-11-20T15:30:00.000Z", updatedAt: "2026-11-20T15:30:00.000Z", capabilities: { ...noCapabilities },
  };
  const withheld = (publicationState: "hidden" | "deleted"): QuestionView => ({
    id: "q", publicationState, content: null, author: null, resolution: null, version: null, createdAt: null, updatedAt: null,
    capabilities: { ...noCapabilities },
  });
  const render = (question: QuestionView) => renderToStaticMarkup(createElement(QuestionDetail, { question }));

  it("本文を制限Markdownとして、題名の下の見出し階層で表示する", () => {
    const html = render(shown);
    expect(html).toMatch(/<h1[^>]*>題名<\/h1>/);
    expect(html).toContain("<h2>見出し</h2>");
    expect(html).toContain("<strong>強調</strong>");
    expect(html).not.toContain("<b>");
    for (const text of ["解決済み", "雑談", 'href="/users/a%20b"', "2026/11/21 0:30"]) expect(html).toContain(text);
    expect(html).not.toContain("非表示");
  });

  it("本人・管理者に表示する強制非表示の質問では、非表示中であることを示す", () => {
    expect(render({ ...shown, publicationState: "hidden" })).toContain("この質問は管理者により非表示になっています。");
  });

  it("削除済み・閲覧できない質問は、状態の案内だけを表示する", () => {
    expect(render(withheld("deleted"))).toContain("この質問は削除されました。");
    expect(render(withheld("hidden"))).toContain("この質問は現在表示できません。");
    for (const state of ["deleted", "hidden"] as const) expect(render(withheld(state))).not.toMatch(/解決|<time|<a /);
  });
});
