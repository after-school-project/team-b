import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MyPostsResults } from "@/app/me/questions/my-posts-results";
import { markdownExcerpt } from "@/markdown/excerpt";
import { markdownProblems, parseWithinLimits, walkMarkdown } from "@/markdown/restricted-markdown";
import type { MyQaItem } from "@/qa/my-posts";

/** 自分のQ&A投稿の一覧（GE-05、#9 ⑥）。抜粋と、各投稿の見出し・QA-02 への導線。 */

/** 比較用に、本文全体を解析して作った抜粋。`markdownExcerpt` と同じ規則で文字を集める。 */
function fullExcerpt(markdown: string): string {
  const blocks = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "thematicBreak", "break"]);
  const parts: string[] = [];
  for (const { node } of walkMarkdown(parseWithinLimits(markdown)!)) {
    if (blocks.has(node.type)) parts.push(" ");
    if (["text", "inlineCode", "code"].includes(node.type)) parts.push(node.value ?? "");
  }
  const characters = [...parts.join("").replace(/\s+/g, " ").trim()];
  return characters.length > 120 ? `${characters.slice(0, 120).join("")}…` : characters.join("");
}

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

  it("詳細の表示で記号として扱うものだけを外し、文字として表示されるものは残す", () => {
    // 詳細の表示は GFM を使わないため、~~ は取り消し線ではなく文字として表示される。抜粋も同じにする。
    expect(markdownExcerpt("3 * 4 = 12、*斜体*と**太字**と~~取り消し~~")).toBe("3 * 4 = 12、斜体と太字と~~取り消し~~");
    expect(markdownExcerpt("snake_case と __強調__ と _斜体_")).toBe("snake_case と 強調 と 斜体");
  });

  it("長い本文は冒頭のブロックだけを解析し、本文全体を解析した場合と同じ抜粋にする", () => {
    const paragraph = "これは**強調**と`code * 2`と[リンク](https://example.com)を含む段落です。".repeat(3);
    let paragraphs = "";
    while ([...paragraphs].length < 9_000) paragraphs += `${paragraph}\n\n- 箇条書き\n\n`;
    const longUrl = `https://example.com/${"a".repeat(1_700)}`;
    const bodies = {
      段落が多い本文: paragraphs,
      空行のない長い段落: paragraphs.replaceAll("\n\n", "\n"),
      "1行の長文": "長い一行の本文です。".repeat(900),
      長いコードブロック: "```\n" + "x * y = z の計算\n".repeat(700) + "```\n後ろ",
      // 以下はレビューで指摘された、詳細と抜粋が食い違っていた本文。
      後半のコード例にある定義らしい行: `[資料][ref]を読む。\n\n${"段落の本文です。\n\n".repeat(150)}\`\`\`\n[ref]: https://example.com/\n\`\`\`\n`,
      URLを次の行に書いた定義: `[資料][ref]を読む。\n\n${"段落の本文です。\n\n".repeat(150)}[ref]:\n  https://example.com/\n`,
      // 1,000文字目より後のコードブロック内の空行で切れる本文。後ろに参照リンクの定義が多くある。
      コードブロックの途中に長い空白: `\`\`\`\n短い出力\n${" ".repeat(1_100)}\n\n \n\`\`\`\n\n本来の続きです。\n\n${"段落。\n\n".repeat(100)}${
        Array.from({ length: 10 }, (_, index) => `[ref${index}]: https://example.com/${"x".repeat(40)}${index}\n`).join("")}`,
      長いURLのインラインリンクで始まる1行: `[資料](${longUrl})を確認。${"続きの本文です。".repeat(100)}`,
    };
    for (const [label, body] of Object.entries(bodies)) {
      expect(markdownProblems(body), label).toEqual([]);
      expect(markdownExcerpt(body), label).toBe(fullExcerpt(body));
    }
    expect(markdownExcerpt(bodies["後半のコード例にある定義らしい行"]).startsWith("[資料][ref]を読む。")).toBe(true);
    expect(markdownExcerpt(bodies["URLを次の行に書いた定義"]).startsWith("資料を読む。")).toBe(true);
    expect(markdownExcerpt(bodies["コードブロックの途中に長い空白"]).startsWith("短い出力 本来の続きです。")).toBe(true);
    expect(markdownExcerpt(bodies["長いURLのインラインリンクで始まる1行"]).startsWith("資料を確認。")).toBe(true);
  });

  it("バッククォート3つ以上で囲んだ1行のインラインコードも、中身を残す", () => {
    expect(markdownExcerpt("```a``` はインライン")).toBe("a はインライン");
    expect(markdownExcerpt("````x ** 2```` の値")).toBe("x ** 2 の値");
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
