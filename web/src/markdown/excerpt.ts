/**
 * 一覧に表示する本文の抜粋（API設計書 §5 MyQaItem.excerpt）。制限Markdownの記号を取り除いた平文の冒頭。
 * 一覧では Markdown として描画せず、文字として表示する。記号の除去は表示のためだけで、厳密な構文解析はしない。
 *
 * コードブロック・インラインコードの中身は書かれたとおりに残す（`a * b` などの演算子を消さない）。
 * それ以外の文では、行頭の見出し・引用・箇条書きの記号、リンクの URL、対になった強調・取り消しの記号だけを外す。
 * 対にならない記号（`3 * 4` の `*` など）や語中の `_`（snake_case など）は残す。
 */
export const excerptLength = 120;

/** コード以外の文から、Markdownの記号を外す。 */
function plainText(source: string): string {
  return source
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // リンク（テキストだけ残す）
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2") // 強調・取り消し（対になったものだけ）
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2"); // 斜体の * も対になったものだけ
}

/** 行頭の見出し・引用・箇条書きの記号を外す。 */
function withoutLinePrefix(line: string): string {
  return line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "");
}

/** インラインコード（同じ数のバッククォートで囲んだ部分）の中身は残し、ほかの部分だけ記号を外す。 */
function inlineText(line: string): string {
  const parts: string[] = [];
  const code = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  let last = 0;
  for (const match of line.matchAll(code)) {
    parts.push(plainText(line.slice(last, match.index)), match[2].trim());
    last = match.index + match[0].length;
  }
  parts.push(plainText(line.slice(last)));
  return parts.join("");
}

export function markdownExcerpt(markdown: string, length = excerptLength): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      // コードブロックの中身はそのまま。同じ種類で同じ長さ以上の囲みで閉じる。
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      else lines.push(line);
    } else if (marker) {
      fence = marker;
    } else {
      lines.push(inlineText(withoutLinePrefix(line)));
    }
  }
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}
