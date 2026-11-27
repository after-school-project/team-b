/**
 * 一覧に表示する本文の抜粋（API設計書 §5 MyQaItem.excerpt）。制限Markdownの記号を取り除いた平文の冒頭。
 * 一覧では Markdown として描画せず、文字として表示する。記号の除去は表示のためだけで、厳密な構文解析はしない。
 */
export const excerptLength = 120;

export function markdownExcerpt(markdown: string, length = excerptLength): string {
  const text = markdown
    .replace(/^\s{0,3}(?:```|~~~).*$/gm, " ") // コードブロックの囲み
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // リンク（テキストだけ残す）
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "") // 見出し・引用・箇条書き
    .replace(/(\*\*|__|\*|~~|`)/g, "") // 強調・取り消し・コード。語中の _（snake_case など）は残す
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}
