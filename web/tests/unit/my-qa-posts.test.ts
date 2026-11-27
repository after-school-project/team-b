import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MyPostsResults } from "@/app/me/questions/my-posts-results";
import { markdownExcerpt } from "@/markdown/excerpt";
import type { MyQaItem } from "@/qa/my-posts";

/** 自分のQ&A投稿の一覧（GE-05、#9 ⑥）。抜粋と、各投稿の見出し・QA-02 への導線。 */

describe("本文の抜粋", () => {
  it("制限Markdownの記号を除いた平文にし、長い本文は120文字で省略する", () => {
    expect(markdownExcerpt("# 見出し\n\n- **強調**と`コード`\n> 引用\n\n[リンク](https://example.com) snake_case"))
      .toBe("見出し 強調とコード 引用 リンク snake_case");
    expect(markdownExcerpt("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(markdownExcerpt("あ".repeat(130))).toBe(`${"あ".repeat(120)}…`);
    expect(markdownExcerpt("𠮷".repeat(121))).toBe(`${"𠮷".repeat(120)}…`);
  });

  it("コードブロック・インラインコードの中身は、演算子や記号を消さずに残す", () => {
    expect(markdownExcerpt("計算は `a * b + c ** 2` です")).toBe("計算は a * b + c ** 2 です");
    expect(markdownExcerpt("```js\nconst x = a * b;\nconst y = ~~z;\n```\n本文")).toBe("const x = a * b; const y = ~~z; 本文");
    expect(markdownExcerpt("~~~\n# コメントではない\n- 箇条書きでもない\n~~~")).toBe("# コメントではない - 箇条書きでもない");
    expect(markdownExcerpt("``a `b` c``")).toBe("a `b` c");
  });

  it("対にならない記号は残し、対になった強調・取り消しだけを外す", () => {
    expect(markdownExcerpt("3 * 4 = 12、*斜体*と**太字**と~~取り消し~~")).toBe("3 * 4 = 12、斜体と太字と取り消し");
    expect(markdownExcerpt("snake_case と __強調__")).toBe("snake_case と 強調");
  });
});

const page = { limit: 20, hasMore: false, nextCursor: null, totalCount: 0 };

function item(overrides: Partial<MyQaItem>): MyQaItem {
  return {
    id: "r", kind: "answer", questionId: "q", questionTitle: "質問の題名", questionState: "public",
    excerpt: "本文", createdAt: "2026-11-20T15:30:00.000Z", targetPath: "/questions/q#response-r", ...overrides,
  };
}

const render = (items: MyQaItem[], options: { kind?: MyQaItem["kind"] | "all"; nextPageHref?: string | null } = {}) =>
  renderToStaticMarkup(createElement(MyPostsResults, {
    items, page: { ...page, totalCount: items.length }, kind: options.kind ?? "all", continued: false,
    firstPageHref: "/me/questions", nextPageHref: options.nextPageHref ?? null,
  }));

describe("自分のQ&A投稿の一覧", () => {
  it("AC-12 質問は題名、回答等は親の質問への投稿として示し、QA-02 へ移動できる", () => {
    const html = render([
      item({ id: "q1", kind: "question", questionId: "q1", questionTitle: "自分の質問", targetPath: "/questions/q1" }),
      item({ id: "c1", kind: "comment", questionTitle: "他人の質問", targetPath: "/questions/q#response-c1" }),
    ]);
    expect(html).toContain('href="/questions/q1">自分の質問</a>');
    expect(html).toContain('href="/questions/q#response-c1">「他人の質問」へのコメント</a>');
    expect(html).toContain("投稿 <span");
    expect(html).toContain("2件");
    expect(html).toContain("2026/11/21 0:30");
  });

  it("削除済み・表示できない質問への投稿は、題名を出さずに状態で示す", () => {
    const html = render([
      item({ id: "a", questionTitle: null, questionState: "deleted" }),
      item({ id: "b", kind: "reply", questionTitle: null, questionState: "hidden" }),
      item({ id: "c", kind: "question", questionState: "hidden", questionTitle: "非表示の自分の質問" }),
    ]);
    expect(html).toContain("削除された質問への回答");
    expect(html).toContain("質問は削除済み");
    expect(html).toContain("表示できない質問への返信");
    expect(html).toContain("質問は非表示");
    expect(html).toContain(">非表示<");
    expect(html).toContain("非表示の自分の質問");
  });

  it("投稿がないときは種類に合わせて案内し、続きがあるときだけ次のページへの導線を出す", () => {
    expect(render([])).toContain("まだ投稿はありません。");
    expect(render([], { kind: "reply" })).toContain("返信の投稿はありません。");
    expect(render([item({})], { nextPageHref: "/me/questions?cursor=x" })).toContain("次の20件を表示");
    expect(render([item({})])).not.toContain("次の20件を表示");
  });
});
