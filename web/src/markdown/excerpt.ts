import { parseWithinLimits, walkMarkdown } from "./restricted-markdown";

/**
 * 一覧に表示する本文の抜粋（API設計書 §5 MyQaItem.excerpt）。制限Markdownの記号を取り除いた平文の冒頭。
 * 一覧では Markdown として描画せず、文字として表示する。
 *
 * 保存時の検証・詳細の表示と同じ解析器（react-markdown）で構文木を作り、文字（テキスト・インラインコード・
 * コードブロック）だけを本文の順に集める。そのため、コードの中の `*` などは書かれたとおりに残り、強調・見出し・
 * 箇条書き・リンクの記号は、詳細の表示で記号として扱われるものだけが外れる。ブロックの間は空白1つで区切る。
 */
export const excerptLength = 120;

/** 前後を空白で区切る要素。 */
const blocks = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "thematicBreak", "break"]);
/** 本文の文字として集める要素。 */
const texts = new Set(["text", "inlineCode", "code"]);

export function markdownExcerpt(markdown: string, length = excerptLength): string {
  const root = parseWithinLimits(markdown);
  let text: string;
  if (root) {
    const parts: string[] = [];
    for (const { node } of walkMarkdown(root)) {
      if (blocks.has(node.type)) parts.push(" ");
      if (texts.has(node.type)) parts.push(node.value ?? "");
    }
    text = parts.join("");
  } else {
    // 保存時に検証しているため通常は解析できる。解析できない本文は、記号を外さずに空白だけをまとめる。
    text = markdown;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : normalized;
}
