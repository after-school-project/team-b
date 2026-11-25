import Markdown, { type Options } from "react-markdown";

/**
 * Q&Aの本文の制限Markdown（Issue #9、画面遷移・状態遷移設計書 §3、2026-11-20・11-25のチーム決定）。
 *
 * - 保存時の検証と表示で、同じ解析器（react-markdown）と同じ上限を使う。
 * - 判定は文字列ではなく構文木で行う。コード内の `<div>` や不等号はHTMLとして扱わない。
 * - 解析器は、深い入れ子でスタックを溢れさせ、記号の大量の並びで処理時間が二乗で増える。本解析の前に上限を確認する。
 */

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

/** 構文木（mdast）のうち、この処理で使う項目。 */
export type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  depth?: number;
  identifier?: string;
  data?: { hProperties?: { href: string } };
  children?: MarkdownNode[];
};

export const markdownLimits = {
  /** 本文の最大文字数（API設計書 §3 LongText）。コードポイントで数える。 */
  characters: 10_000,
  /** 1行の先頭に並べられる引用・リストの記号の数。 */
  markersPerLine: 20,
  /** 空でない行の数。 */
  lines: 1_000,
  /** 構文木の深さ。 */
  depth: 100,
  /** 構文木の要素の数。段落などのほか、文中の文字・強調・リンクなども数える。 */
  nodes: 5_000,
  /** 1つの段落・見出しの中の `*`・`_`・`[`・`<`・バッククォートの数。 */
  markersPerParagraph: 500,
  /** 参照リンクで展開されるURLの合計の長さ。 */
  referencedUrlLength: 10_000,
} as const;

export type MarkdownProblem = "too_complex" | "html" | "url" | "image";

const httpUrl = /^https?:\/\//i;

/**
 * リンク先として表示するURL。許可しないURL（相対URL・`//`・HTTP／HTTPS以外・解釈できないURL）では null を返す。
 *
 * 保存時の検証と表示で、必ずこの値を使う。react-markdown は `\`・`[`・`]` などを%表記に変えるため、
 * 元のURLを渡すと、検証したものとは別のホストへのリンクや、開けないリンクになる。
 */
export function linkHref(url: string): string | null {
  return httpUrl.test(url) && URL.canParse(url) ? new URL(url).href : null;
}

/** 同じ記号と空白だけの行（水平線）。リストの入れ子としては数えない。 */
const thematicBreak = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const containerMarker = /[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))/y;

function leadingMarkers(line: string): number {
  if (thematicBreak.test(line)) return 0;
  containerMarker.lastIndex = 0;
  let count = 0;
  while (count <= markdownLimits.markersPerLine && containerMarker.test(line)) count += 1;
  return count;
}

/** 段落・リストなどのブロックだけを解析するため、文中の構文を無効にする。 */
const blockOnly = {
  disable: {
    null: [
      "attention", "autolink", "characterEscape", "characterReference", "codeText",
      "hardBreakEscape", "htmlText", "labelEnd", "labelStartImage", "labelStartLink",
    ],
  },
};

type ParserContext = { data(): { micromarkExtensions?: unknown[] } };

function parse(value: string, extension?: object): MarkdownNode {
  let parsed: MarkdownNode | undefined;
  const capture = function (this: ParserContext) {
    if (extension) (this.data().micromarkExtensions ??= []).push(extension);
    return (tree: MarkdownNode): MarkdownNode => {
      parsed = tree;
      // 構文木だけを使うため、後続の変換には空の木を渡す。
      return { type: "root", children: [] };
    };
  };
  Markdown({ children: value, remarkPlugins: [capture] as unknown as RemarkPlugins });
  return parsed!;
}

/** 構文木の全要素を、本文の順にたどる。深い木でもスタックを溢れさせないよう、再帰を使わない。 */
export function* walkMarkdown(root: MarkdownNode): Generator<{ node: MarkdownNode; depth: number }> {
  const pending = [{ node: root, depth: 0 }];
  for (let current = pending.pop(); current; current = pending.pop()) {
    yield current;
    for (const node of (current.node.children ?? []).toReversed()) pending.push({ node, depth: current.depth + 1 });
  }
}

function paragraphMarkers(paragraph: MarkdownNode): number {
  let count = 0;
  for (const { node } of walkMarkdown(paragraph)) count += node.value?.match(/[*_[<`]/g)?.length ?? 0;
  return count;
}

/** 本解析（文中の構文の解析と描画）をしてはいけない量かを判定する。 */
export function exceedsParseLimits(value: string): boolean {
  // 1文字は最大2つのUTF-16コードユニットになる。文字を数える前に、明らかに長い値を除く。
  if (value.length > markdownLimits.characters * 2 || [...value].length > markdownLimits.characters) return true;
  const lines = value.split(/\r\n?|\n/).filter((line) => line.trim() !== "");
  if (lines.length > markdownLimits.lines) return true;
  if (lines.some((line) => leadingMarkers(line) > markdownLimits.markersPerLine)) return true;
  let nodes = 0;
  for (const { node } of walkMarkdown(parse(value, blockOnly))) {
    nodes += 1;
    if (nodes > markdownLimits.nodes) return true;
    if ((node.type === "paragraph" || node.type === "heading") &&
      paragraphMarkers(node) > markdownLimits.markersPerParagraph) return true;
  }
  return false;
}

/** 解析した構文木が、描画してはいけない要素数・深さ・展開量かを判定する。 */
export function exceedsTreeLimits(root: MarkdownNode): boolean {
  const definitions = new Map<string, string>();
  const references: string[] = [];
  let nodes = 0;
  for (const { node, depth } of walkMarkdown(root)) {
    nodes += 1;
    if (nodes > markdownLimits.nodes || depth > markdownLimits.depth) return true;
    const { identifier = "" } = node;
    // 同じ名前の定義は最も長いURLで数え、どの定義が使われても上限を超えないようにする。
    if (node.type === "definition" && (definitions.get(identifier) ?? "").length < node.url!.length) {
      definitions.set(identifier, node.url!);
    }
    if (node.type === "linkReference" || node.type === "imageReference") references.push(identifier);
  }
  let length = 0;
  for (const identifier of references) length += definitions.get(identifier)?.length ?? 0;
  return length > markdownLimits.referencedUrlLength;
}

/** 上限に収まる本文の構文木を返す。収まらない本文と、解析器がスタックを使い切った本文では null を返す。 */
function parseWithinLimits(value: string): MarkdownNode | null {
  try {
    if (exceedsParseLimits(value)) return null;
    const root = parse(value);
    return exceedsTreeLimits(root) ? null : root;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** 保存できない理由。空の配列なら保存できる。 */
export function markdownProblems(value: string): MarkdownProblem[] {
  const root = parseWithinLimits(value);
  if (!root) return ["too_complex"];
  const problems = new Set<MarkdownProblem>();
  for (const { node } of walkMarkdown(root)) {
    if (node.type === "html") problems.add("html");
    if (node.type === "image" || node.type === "imageReference") problems.add("image");
    // 参照リンクは、使われていない定義も含めて確認する。
    if ((node.type === "link" || node.type === "definition" || node.type === "image") &&
      linkHref(node.url!) === null) problems.add("url");
  }
  return [...problems];
}
