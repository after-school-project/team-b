import { parseWithinLimits, walkMarkdown, type MarkdownNode } from "./restricted-markdown";

/**
 * 一覧に表示する本文の抜粋（API設計書 §5 MyQaItem.excerpt）。制限Markdownの記号を取り除いた平文の冒頭。
 * 一覧では Markdown として描画せず、文字として表示する。
 *
 * 保存時の検証・詳細の表示と同じ解析器（react-markdown）で構文木を作り、文字（テキスト・インラインコード・
 * コードブロック）だけを本文の順に集める。そのため、コードの中の `*` などは書かれたとおりに残り、強調・見出し・
 * 箇条書き・リンクの記号は、詳細の表示で記号として扱われるものだけが外れる。ブロックの間は空白1つで区切る。
 *
 * 一覧のたびに長い本文全体を同期的に解析しないよう、本文の冒頭だけを解析する（`leadingText`）。
 * - 解析する範囲は、約 `initialRange` 文字の後の段落の区切り（空行）までとする。近くに空行がなければ改行、改行もなければ
 *   文字の位置で切る。集めた文字が抜粋の2倍に満たなければ、範囲を2倍ずつ広げる（最大でも本文全体の約2倍の処理）。
 * - 抜粋に使う冒頭の文字は、切った位置から抜粋の長さ以上離れているため、本文全体を解析したときと同じになる。
 *   違いが出るのは、冒頭で始まった強調・コードが切った位置をまたぐほど長い場合だけ（記号が文字として残る）。
 * - 範囲の外にある参照リンクの定義（`[名前]: URL`）は、範囲の末尾に付け足して、リンクの文字を詳細の表示と同じにする。
 *   範囲の末尾がコードブロックの途中でも、付け足した行は切った位置より後ろに入るため、冒頭の文字は変わらない。
 */
export const excerptLength = 120;

/** 最初に解析する文字数の目安（UTF-16 の長さ）。抜粋の120文字に対して、記号・URLの分を見込む。 */
const initialRange = 1_000;

/** 前後を空白で区切る要素。 */
const blocks = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "thematicBreak", "break"]);
/** 本文の文字として集める要素。 */
const texts = new Set(["text", "inlineCode", "code"]);
/** 参照リンクの定義の行（`[名前]: URL`）。 */
const definitionLine = /^ {0,3}\[[^\]]+\]:/;

function textOf(root: MarkdownNode): string {
  const parts: string[] = [];
  for (const { node } of walkMarkdown(root)) {
    if (blocks.has(node.type)) parts.push(" ");
    if (texts.has(node.type)) parts.push(node.value ?? "");
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * 解析する範囲の終わり。`range` 文字目から `range` 文字以内の最初の空行、なければ改行、どちらもなければ `range` 文字目。
 * 文字の途中（サロゲートペアの間）では切らない。
 */
function cutPoint(markdown: string, range: number): number {
  if (range >= markdown.length) return markdown.length;
  const window = markdown.slice(0, Math.min(markdown.length, range * 2));
  const blank = /\n[ \t]*(?:\r?\n|$)/g;
  blank.lastIndex = range;
  const paragraph = blank.exec(window)?.index;
  if (paragraph !== undefined) return paragraph;
  const line = window.indexOf("\n", range);
  if (line >= 0) return line;
  const code = markdown.charCodeAt(range - 1);
  return code >= 0xd800 && code <= 0xdbff ? range + 1 : range;
}

/** 抜粋の元になる冒頭の平文。解析できない本文は null。 */
function leadingText(markdown: string, length: number): string | null {
  for (let range = initialRange; ; range *= 2) {
    const end = cutPoint(markdown, range);
    const whole = end >= markdown.length;
    const definitions = whole ? [] : markdown.slice(end).split(/\r\n|\r|\n/).filter((line) => definitionLine.test(line));
    const root = parseWithinLimits(whole ? markdown : [markdown.slice(0, end), "", ...definitions].join("\n"));
    if (!root) return null;
    const text = textOf(root);
    // 切った位置の近くの文字は、範囲の外の文字とのつながりで変わり得るため、抜粋の2倍の文字が集まるまで広げる。
    if (whole || [...text].length > length * 2) return text;
  }
}

export function markdownExcerpt(markdown: string, length = excerptLength): string {
  // 保存時に検証しているため通常は解析できる。解析できない本文は、記号を外さずに空白だけをまとめる。
  const text = leadingText(markdown, length) ?? markdown.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}
