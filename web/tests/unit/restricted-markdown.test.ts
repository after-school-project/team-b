import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJson } from "@/api/request";
import { ApiError } from "@/api/response";
import { RestrictedMarkdown } from "@/components/markdown/RestrictedMarkdown";
import { longMarkdown, markdownProblemMessages, shortMarkdown } from "@/markdown/input";
import { markdownLimits, markdownProblems } from "@/markdown/restricted-markdown";

const render = (source: string, headingLevel?: 2 | 3 | 4) =>
  renderToStaticMarkup(createElement(RestrictedMarkdown, { source, headingLevel }));
const body = (value: string, headingLevel?: 2 | 3 | 4) => render(value, headingLevel).replace(/^<div[^>]*>|<\/div>$/g, "");
const isPlain = (value: string) => /^<div class="[^"]*plain[^"]*">/.test(render(value));

const allowedTag = /^<\/?(?:p|h[2-6]|em|strong|ul|li|blockquote|pre|code|br\/|ol(?: start="\d+")?|a(?: href="https?:\/\/[^"]*" rel="nofollow noopener noreferrer")?)>$/;

/** 許可した要素・属性・URLだけが描画されていることを確認する。 */
function expectOnlyAllowed(value: string) {
  const unexpected = [...body(value).matchAll(/<[^>]*>/g)].map(([tag]) => tag).filter((tag) => !allowedTag.test(tag));
  expect(unexpected, value).toEqual([]);
}

const html = [
  "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "a <b>b</b> c", "<!-- x -->", "<![CDATA[x]]>", "<?php x ?>",
  "<!DOCTYPE html>", "<iframe src='https://e.com'></iframe>", "a </div> b", "<img\nsrc=x\nonerror=alert(1)>",
  "<a href='https://e.com'>x</a>", "a<br>b", "> - <script>alert(1)</script>", "<script>\nalert(1)",
  "<svg><script>alert(1)</script></svg>", "<math><mtext></mtext></math>", "<x-y z=1>", "地の文の List<String>",
];

const urls = [
  // 大文字・空白・制御文字・実体参照・エスケープ
  "[a](javascript:alert(1))", "[a](JaVaScRiPt:alert(1))", "[a](< javascript:alert(1)>)", "[a](   javascript:alert(1))",
  "[a](<java\tscript:alert(1)>)", "[a](&#106;avascript:alert(1))", "[a](&#x6A;avascript&#x3A;alert(1))",
  "[a](javascript&colon;alert(1))", "[a](java&Tab;script:alert(1))", "[a](java&NewLine;script:alert(1))",
  "[a](&#1;javascript:alert(1))", "[a](&nbsp;javascript:alert(1))", "[a](javascript\\:alert(1))",
  "[a](javascript%3Aalert(1))", "[a](<javascript:alert(1)>)", '[a](javascript:alert(1) "t")', "[a\nb](\njavascript:alert(1)\n)",
  // 参照リンク
  "[a][r]\n\n[r]: javascript:alert(1)", "[r][]\n\n[r]: JAVASCRIPT:alert(1)", "[r]\n\n[r]: <javascript:alert(1)>",
  "[r]\n\n[r]: &#x6a;avascript:alert(1)", "a\n\n[r]: javascript:alert(1)", "[r]\n\n[r]: https://e.com\n[r]: javascript:alert(1)",
  "> [r]: javascript:alert(1)\n\n[r]",
  // 自動リンク
  "<javascript:alert(1)>", "<JAVASCRIPT:alert(1)>", "<data:text/html,x>", "<vbscript:x>", "<file:///etc/passwd>",
  "<a@example.com>", "<mailto:a@example.com>", "<tel:000>",
  // その他のスキーム・相対URL
  "[a](data:text/html;base64,PHNjcmlwdD4=)", "[a](DATA:text/html,x)", "[a](vbscript:msgbox)", "[a](blob:https://e.com/x)",
  "[a](file:///c:/x)", "[a](ftp://e.com)", "[a](mailto:a@e.com)", "[a](feed:javascript:alert(1))", "[a](http:javascript:alert(1))",
  "[a](/admin)", "[a](../x)", "[a](#x)", "[a](?x=1)", "[a](//e.com)", "[a](\\\\\\\\e.com)", "[a](https:/e.com)", "[a](https:e.com)",
  "[a](https:\\\\\\\\e.com)", "[a]()", "[a](https://)", "[a](ｊavascript:alert(1))",
  // ほかの構文の中
  "[a <javascript:alert(1)>](https://e.com)", "# [a](javascript:alert(1))", "**[a](javascript:alert(1))**",
  "1. [a](javascript:alert(1))", "[a](javascript:alert(1))\n===",
];

const images = [
  "![a](https://e.com/a.png)", "![a][r]\n\n[r]: https://e.com/a.png", "![a](data:image/svg+xml;base64,AA)",
  "[![a](https://e.com/a.png)](https://e.com)",
];

/** 保存でき、許可した構文として表示する入力。 */
const accepted: [string, string][] = [
  ["段落1\n\n段落2", "<p>段落1</p>\n<p>段落2</p>"],
  ["# a\n\n## b", "<h3>a</h3>\n<h4>b</h4>"],
  ["*a* **b**", "<p><em>a</em> <strong>b</strong></p>"],
  ["- a\n  - b", "<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ul>"],
  ["3. a\n4. b", '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>'],
  ["> a", "<blockquote>\n<p>a</p>\n</blockquote>"],
  ["a  \nb", "<p>a<br/>\nb</p>"],
  ["a\\\nb", "<p>a<br/>\nb</p>"],
  ["`<div>`", "<p><code>&lt;div&gt;</code></p>"],
  ["```html\n<b>x</b>\n[a](javascript:1)\n![i](x)\n```", "<pre><code>&lt;b&gt;x&lt;/b&gt;\n[a](javascript:1)\n![i](x)\n</code></pre>"],
  ["    <script>x</script>", "<pre><code>&lt;script&gt;x&lt;/script&gt;\n</code></pre>"],
  ["> ```\n> <b>x</b>\n> ```", "<blockquote>\n<pre><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>\n</blockquote>"],
  ["a < b && c > d", "<p>a &lt; b &amp;&amp; c &gt; d</p>"],
  ["1 <2, x<y, a <- b, <3", "<p>1 &lt;2, x&lt;y, a &lt;- b, &lt;3</p>"],
  ["<あいう>", "<p>&lt;あいう&gt;</p>"],
  ["\\<div\\>", "<p>&lt;div&gt;</p>"],
  ["&lt;script&gt;", "<p>&lt;script&gt;</p>"],
  // CommonMark ではHTMLではなく、文字として表示される。
  ["<svg/onload=alert(1)>", "<p>&lt;svg/onload=alert(1)&gt;</p>"],
  ["javascript: とは？ data:image も本文", "<p>javascript: とは？ data:image も本文</p>"],
  ["[a](https://e.com/x?y=1&z=2#f)", '<p><a href="https://e.com/x?y=1&amp;z=2#f" rel="nofollow noopener noreferrer">a</a></p>'],
  ["[a](http://localhost:3000)", '<p><a href="http://localhost:3000/" rel="nofollow noopener noreferrer">a</a></p>'],
  ["[a](HTTPS://e.com)", '<p><a href="https://e.com/" rel="nofollow noopener noreferrer">a</a></p>'],
  ["<https://e.com/x>", '<p><a href="https://e.com/x" rel="nofollow noopener noreferrer">https://e.com/x</a></p>'],
  ["[a][r]\n\n[r]: https://e.com", '<p><a href="https://e.com/" rel="nofollow noopener noreferrer">a</a></p>'],
  // 水平線は保存でき、表示時に取り除く。
  ["a\n\n---\n\nb", "<p>a</p>\n\n<p>b</p>"],
  // 対象外の構文（表・取り消し線・URLの自動リンク）は文字のまま表示する。
  ["~~a~~ https://e.com", "<p>~~a~~ https://e.com</p>"],
];

/** 保存できるリンクと、表示するhref。元のURLをブラウザーが解釈した値と同じになる。 */
const links: [string, string][] = [
  // 描画の処理が \ を %5C に変えると、無効なURLや、別のホスト（evil.example）へのリンクになる。
  ["[a](https://example.com\\course)", "https://example.com/course"],
  ["<https://example.com\\course>", "https://example.com/course"],
  ["[a][r]\n\n[r]: https://example.com\\course", "https://example.com/course"],
  ["[a](https://good.example\\\\@evil.example/)", "https://good.example/@evil.example/"],
  ["<https://good.example\\@evil.example/>", "https://good.example/@evil.example/"],
  ["[r]\n\n[r]: https://good.example\\\\@evil.example/", "https://good.example/@evil.example/"],
  ["[a](https://good.example:8080\\\\@evil.example)", "https://good.example:8080/@evil.example"],
  ["[a](http://[::1]/)", "http://[::1]/"],
  ["<https://[2001:db8::1]:8080/x>", "https://[2001:db8::1]:8080/x"],
  ["[a][r]\n\n[r]: http://[::1]:3000/x", "http://[::1]:3000/x"],
  ["[a](https://日本.example/あ?い=う)", "https://xn--wgv71a.example/%E3%81%82?%E3%81%84=%E3%81%86"],
  ["[a](<https://e.com/a b[c]>)", "https://e.com/a%20b[c]"],
  ["[a](https://e.com/%zz%41)", "https://e.com/%zz%41"],
  ["[a](https:///e.com/x)", "https://e.com/x"],
  ["[a](https://e.com/(x)'y)", "https://e.com/(x)'y"],
  // 同じ名前の定義は、最初のものを使う。
  ["[R]\n\n[r]: https://a.example/\n[R]: https://b.example/", "https://a.example/"],
  ["[r]\n\n> [r]: https://a.example/\n\n[r]: https://b.example/", "https://a.example/"],
];

/** 描画の処理が書き換えると、有効なURLに見えるようになる無効なURL。 */
const invalidLinks = [
  "[a](https://good.example:xx\\\\@evil.example/)", "<https://good.example:xx\\@evil.example/>",
  "[r]\n\n[r]: https://good.example:xx\\\\@evil.example/", "[a](http://[::1)", "[a](http://[x]/)", "[a](<https://a b.example/>)",
];

/** 画面遷移・状態遷移設計書 §3、API設計書 §3、#9 の2026-11-20・11-25の決定。AC-04 の Markdown の検証。 */
describe("制限Markdownの保存時の検証", () => {
  it.each(html)("生HTMLを拒否する: %j", (value) => {
    expect(markdownProblems(value)).toContain("html");
  });

  it.each(urls)("HTTP／HTTPS以外のURLを拒否する: %j", (value) => {
    expect(markdownProblems(value)).toContain("url");
  });

  it.each(images)("画像を拒否する: %j", (value) => {
    expect(markdownProblems(value)).toContain("image");
  });

  it.each(accepted)("許可した構文・コード内の文字列・不等号を受け付ける: %j", (value) => {
    expect(markdownProblems(value)).toEqual([]);
  });

  it("理由が複数ある場合は、すべて返す", () => {
    expect(markdownProblems("<b>a</b> [a](javascript:1) ![a](https://e.com)").sort()).toEqual(["html", "image", "url"]);
  });
});

describe("制限Markdownの表示", () => {
  it.each(accepted)("許可した構文を表示する: %j", (value, expected) => {
    expect(body(value)).toBe(expected);
  });

  it.each([...html, ...urls, ...images])("保存済みの本文に含まれていても、許可外の要素・属性・URLを描画しない: %j", (value) => {
    expectOnlyAllowed(value);
  });

  it.each(links)("保存できるリンクは、検証したURLと同じ有効なhrefで表示する: %j", (value, expected) => {
    expect(markdownProblems(value)).toEqual([]);
    const hrefs = [...body(value).matchAll(/ href="([^"]*)"/g)].map(([, href]) => href.replaceAll("&#x27;", "'").replaceAll("&amp;", "&"));
    expect(hrefs).toEqual([expected]);
    expect(new URL(expected).href).toBe(expected);
  });

  it.each(invalidLinks)("解釈できないURLは保存時に拒否し、表示ではリンクにしない: %j", (value) => {
    expect(markdownProblems(value)).toEqual(["url"]);
    expect(body(value)).not.toContain("href");
  });

  it("本文の見出しは画面の見出し階層に合わせ、h6を超えない", () => {
    expect(body("# a\n\n### b", 2)).toBe("<h2>a</h2>\n<h4>b</h4>");
    expect(body("# a\n\n###### b", 4)).toBe("<h4>a</h4>\n<h6>b</h6>");
  });
});

const fit = (value: string) => [...value].slice(0, markdownLimits.characters).join("");
const fill = (unit: string) => fit(unit.repeat(markdownLimits.characters));

/** 上限がないと、スタックを溢れさせるか、解析に1秒以上かかる入力。 */
const excessive: [string, string][] = [
  ["引用の入れ子", fill(">")],
  ["空白のある引用の入れ子", fill("> ")],
  ["タブのある引用の入れ子", fill(">\t")],
  ["箇条書きの入れ子（+）", fill("+ ")],
  ["番号付きリストの入れ子", fill("1. ")],
  ["引用と箇条書きの入れ子", fill("> - ")],
  ["リストの中の遅延継続行", `${"- ".repeat(1000)}a${"\na".repeat(3900)}`],
  ["強調の入れ子", `${"*".repeat(5000)}a${"*".repeat(4999)}`],
  ["2種類の強調の入れ子", `${"*_".repeat(2499)}a${"_*".repeat(2499)}`],
  ["強調の開始の並び", fill("*a")],
  ["強制改行で区切った強調の並び", fill("*a  \n_b  \n")],
  ["強制改行で区切った1段落の強調の並び", `${"*a*_b_*c  \n".repeat(300)}`],
  ["閉じないHTMLコメントの並び", fill("a><!--")],
  ["エスケープしたバッククォートの並び", fill("`` \\")],
  ["閉じないコードの並び", fill("\\``")],
  ["画像の入れ子", `${"![".repeat(1428)}${"](a)".repeat(1428)}`],
  ["短い見出しの並び", fill("a\n-\n")],
  ["1行の箇条書きの並び", fill("- a\n")],
  ["入れ子のリストの並び", fill(`${"- ".repeat(20)}a\n`)],
  ["字下げで深くしたリスト", Array.from({ length: 70 }, (_, level) => `${" ".repeat(level * 2)}- a`).join("\n")],
  ["参照リンクによるURLの展開", `[a]: https://${"e".repeat(4000)}\n\n${"[a]\n\n".repeat(900)}`],
];

describe("制限Markdownの上限", () => {
  it.each(excessive)("上限を超える本文を保存時に拒否し、表示では文字のまま表示する: %s", (_name, value) => {
    expect([...value].length).toBeLessThanOrEqual(markdownLimits.characters);
    const started = performance.now();
    expect(markdownProblems(value)).toEqual(["too_complex"]);
    expect(isPlain(value)).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("文字のまま表示するときも、HTMLとして解釈させない", () => {
    expect(render(`${">".repeat(21)}<script>alert(1)</script>`)).not.toContain("<script");
  });

  it("上限ちょうどの本文は受け付け、1つ超えると拒否する", () => {
    const { markersPerLine, lines, markersPerParagraph, characters, nodes } = markdownLimits;
    // 文字とコードの組（2要素）を段落（1要素）に並べる。根の1、9段落の4,509、最後の段落の490で、ちょうど5,000要素。
    const inline = [...Array<string>(9).fill("a`b`".repeat(250)), `${"a`b`".repeat(244)}a`].join("\n\n");
    expect(nodes).toBe(5_000);
    const cases: [string, string][] = [
      [`${">".repeat(markersPerLine)} a`, `${">".repeat(markersPerLine + 1)} a`],
      ["a\n".repeat(lines), "a\n".repeat(lines + 1)],
      ["[".repeat(markersPerParagraph), "[".repeat(markersPerParagraph + 1)],
      ["\\`".repeat(markersPerParagraph), "\\`".repeat(markersPerParagraph + 1)],
      ["𠮷".repeat(characters), "𠮷".repeat(characters + 1)],
      [inline, `${inline}\`c\``],
    ];
    for (const [within, over] of cases) {
      expect(markdownProblems(within)).toEqual([]);
      expect(isPlain(within)).toBe(false);
      expect(markdownProblems(over)).toEqual(["too_complex"]);
      expect(isPlain(over)).toBe(true);
    }
  });

  it("参照リンクで展開されるURLは、表示するhrefの長さで数える", () => {
    const { referencedUrlLength } = markdownLimits;
    // 日本語1文字はUTF-8の3バイトで、hrefでは9文字になる。「https://e.com/」は14文字。
    const source = (japanese: number, ascii: number) =>
      `[a]: https://e.com/${"あ".repeat(japanese)}${"a".repeat(ascii)}\n\n${"[a]\n\n".repeat(10)}`;
    const length = (value: string) =>
      [...body(value).matchAll(/ href="([^"]*)"/g)].reduce((total, [, href]) => total + href.length, 0);
    const within = source(100, 86);
    expect(length(within)).toBe(referencedUrlLength);
    expect(markdownProblems(within)).toEqual([]);
    for (const over of [source(100, 87), source(110, 0)]) {
      expect(markdownProblems(over)).toEqual(["too_complex"]);
      expect(isPlain(over)).toBe(true);
    }
  });

  it.each([
    ["後の定義の方が長い", `[a]: https://e.com/\n[a]: https://e.com/${"あ".repeat(200)}\n\n${"[a]\n\n".repeat(10)}`],
    ["前の定義の方が長い", `[a]: https://e.com/${"あ".repeat(200)}\n[a]: https://e.com/\n\n${"[a]\n\n".repeat(10)}`],
    ["正規化で短くなる", `[a]: https://e.com/${"a/../".repeat(800)}\n\n${"[a]\n\n".repeat(600)}`],
    ["日本語のホスト", `[a]: https://${"日本.".repeat(200)}example/\n\n${"[a]\n\n".repeat(10)}`],
  ])("参照リンクで展開されるURLが上限を超える本文を拒否する: %s", (_name, value) => {
    expect(markdownProblems(value)).toEqual(["too_complex"]);
    expect(isPlain(value)).toBe(true);
  });

  it("文中の強調を分けて並べた本文も、構文木全体の要素数で拒否する", () => {
    const value = Array.from({ length: 40 }, () => "*a*b".repeat(60)).join("\n\n");
    expect(markdownProblems(value)).toEqual(["too_complex"]);
    expect(isPlain(value)).toBe(true);
  });

  it("普通の長い本文・記号の多いコード・区切り線・表風の文字を受け付ける", () => {
    const values = [
      fill("日本語の文章です。"),
      fill("## 見出し\n\n段落 **強調** `code` [リンク](https://example.com)\n\n- 項目\n- 項目\n\n> 引用\n\n"),
      `\`\`\`c\n${"a[i] = *p * b_c + x_[j] * *q;\n".repeat(300)}\`\`\``,
      `\`\`\`\n${"+ - + - + - + - +\n".repeat(50)}\`\`\``,
      "**重要**: これは *例* です。[資料](https://e.com)\n".repeat(60),
      "| - | - | - | - |\n".repeat(50),
      "> > > 引用\n".repeat(50),
      `${"- ".repeat(40)}\n\n${"* ".repeat(40)}\n\n${"-".repeat(200)}`,
    ];
    for (const value of values) {
      expect(markdownProblems(value), value.slice(0, 30)).toEqual([]);
      expect(isPlain(value), value.slice(0, 30)).toBe(false);
    }
  });
});

describe("制限Markdownの入力", () => {
  const schema = z.object({ bodyMarkdown: longMarkdown });
  const read = (bodyMarkdown: unknown) => readJson(new Request("https://school.example", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bodyMarkdown }),
  }), schema).then((value) => ({ value }), (error: ApiError) => ({ code: error.code, fields: error.options.fields }));

  it("改行をLFにそろえ、前後の空白を残した本文を返す", async () => {
    expect(await read("  a\r\n\r\n- b  ")).toEqual({ value: { bodyMarkdown: "  a\n\n- b  " } });
  });

  it.each([
    ["<b>秘密の本文</b>", "html"], ["[秘密の本文](javascript:alert(1))", "url"],
    ["![秘密の本文](https://e.com)", "image"], [`${">".repeat(21)}秘密の本文`, "too_complex"],
  ] as const)("422で項目と理由を返し、本文を応答に含めない: %j", async (value, problem) => {
    const result = await read(value);
    expect(result).toEqual({
      code: "VALIDATION_FAILED",
      fields: [{ path: "bodyMarkdown", code: `markdown_${problem}`, message: markdownProblemMessages[problem] }],
    });
    expect(JSON.stringify(result)).not.toContain("秘密");
  });

  it("空白だけ・文字数の超過は、Markdownとして解析せずに拒否する", async () => {
    for (const value of ["", " \n ", "あ".repeat(10_001), ">".repeat(100_000), null, "NUL\0"]) {
      const result = await read(value);
      expect(result).toMatchObject({ code: "VALIDATION_FAILED", fields: [{ path: "bodyMarkdown", message: "入力値を確認してください。" }] });
    }
  });

  it("コメント・返信は2,000文字まで受け付け、同じMarkdownの検証を行う", () => {
    expect(shortMarkdown.safeParse("あ".repeat(2000)).success).toBe(true);
    expect(shortMarkdown.safeParse("あ".repeat(2001)).success).toBe(false);
    expect(shortMarkdown.safeParse("<b>a</b>").success).toBe(false);
    expect(longMarkdown.safeParse("あ".repeat(10_000)).success).toBe(true);
  });
});
