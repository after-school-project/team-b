import { parseBlocksWithinLimits, parseWithinLimits, walkMarkdown, type MarkdownNode } from "./restricted-markdown";

/**
 * 一覧に表示する本文の抜粋（API設計書 §5 MyQaItem.excerpt）。制限Markdownの記号を取り除いた平文の冒頭。
 * 一覧では Markdown として描画せず、文字として表示する。
 *
 * 保存時の検証・詳細の表示と同じ解析器（react-markdown）で構文木を作り、文字（テキスト・インラインコード・
 * コードブロック）だけを本文の順に集める。そのため、コードの中の `*` などは書かれたとおりに残り、強調・見出し・
 * 箇条書き・リンクの記号は、詳細の表示で記号として扱われるものだけが外れる。ブロックの間は空白1つで区切る。
 *
 * 一覧のたびに長い本文全体を同期的に解析しないよう、冒頭のブロックだけを解析する（`leadingBlocksEnd`）。
 * 切る位置は、トップレベルのブロックの境目に限る。文中の構文（強調・コード・リンク）はブロックをまたがないため、
 * 切った範囲の文字は、本文全体を解析した場合と同じになる。参照リンクの定義を使う可能性がある本文と、冒頭に閉じたブロックが
 * ない本文（長い1段落など）は、本文全体を解析する（`leadingText`）。段落の多い長文で、解析の量を減らせる。
 */
export const excerptLength = 120;

/** 最初にブロックの構造を調べる文字数の目安（UTF-16 の長さ）。抜粋の120文字に対して、記号・URLの分を見込む。 */
const initialRange = 1_000;

/** 前後を空白で区切る要素。 */
const blocks = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "thematicBreak", "break"]);
/** 本文の文字として集める要素。 */
const texts = new Set(["text", "inlineCode", "code"]);

function textOf(root: MarkdownNode): string {
  const parts: string[] = [];
  for (const { node } of walkMarkdown(root)) {
    if (blocks.has(node.type)) parts.push(" ");
    if (texts.has(node.type)) parts.push(node.value ?? "");
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * 本文全体を解析した場合と同じブロックだけを含む、冒頭の範囲の終わり。範囲に収まるブロックがなければ null。
 *
 * ブロックの構造は前の行から順に決まり、後ろの行で閉じられる。冒頭の `range` 文字の後の最初の改行までをブロックだけで
 * 解析し、最後のブロック（後ろの行で続く可能性がある）の手前までを使う。それより前のブロックは範囲内の行で閉じられて
 * いるため、本文全体を解析した場合と同じになる。
 */
function leadingBlocksEnd(markdown: string, range: number): number | null {
  const lineEnd = markdown.indexOf("\n", range);
  if (lineEnd < 0) return null;
  const root = parseBlocksWithinLimits(markdown.slice(0, lineEnd));
  const children = root?.children ?? [];
  const last = children.at(-1)?.position?.start.offset;
  return children.length > 1 && last !== undefined && last > 0 ? last : null;
}

/**
 * 後ろの参照リンクの定義を、前の `[` が参照する可能性があるか。定義の文脈（コードブロックの中か、URL が次の行か）は
 * 本文全体を解析しないと判定できないため、`]:` の前に `[` があれば可能性があるとみなす。
 */
function mayUseDefinition(markdown: string): boolean {
  const definition = markdown.lastIndexOf("]:");
  return definition >= 0 && markdown.indexOf("[") < definition;
}

/**
 * 抜粋の元になる冒頭の平文。解析できない本文は null。
 * 冒頭の範囲に閉じたブロックがない本文（長い1段落・1行・1つのコードブロックなど）は、範囲を広げても文中の構文が
 * 決まらないため、すぐに本文全体を解析する。参照リンクの定義を使う可能性がある本文も、本文全体を解析する。
 */
function leadingText(markdown: string, length: number): string | null {
  if (!mayUseDefinition(markdown)) {
    let previous = 0;
    for (let range = initialRange; range < markdown.length; range *= 2) {
      const end = leadingBlocksEnd(markdown, range);
      // 範囲を広げても閉じたブロックが増えない（後ろが1つの長いブロック）なら、広げ続けずに本文全体を解析する。
      if (end === null || end <= previous) break;
      previous = end;
      const root = parseWithinLimits(markdown.slice(0, end));
      if (!root) break;
      const text = textOf(root);
      if ([...text].length > length) return text;
    }
  }
  const root = parseWithinLimits(markdown);
  return root ? textOf(root) : null;
}

export function markdownExcerpt(markdown: string, length = excerptLength): string {
  // 保存時に検証しているため通常は解析できる。解析できない本文は、記号を外さずに空白だけをまとめる。
  const text = leadingText(markdown, length) ?? markdown.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}
