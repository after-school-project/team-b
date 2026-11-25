import Markdown, { type Components, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { ReactElement } from "react";
import { exceedsParseLimits, exceedsTreeLimits, linkHref, walkMarkdown, type MarkdownNode } from "@/markdown/restricted-markdown";
import styles from "./RestrictedMarkdown.module.css";

type HeadingLevel = 2 | 3 | 4;

export type RestrictedMarkdownProps = {
  /** 制限Markdownの本文。 */
  source: string;
  /** 本文の `#` を表示する見出しの階層。画面の見出し階層に合わせる。 */
  headingLevel?: HeadingLevel;
};

/** 表示を許可する要素。画像・水平線・生HTMLなど、ここにない要素は取り除く。 */
const allowedElements = [
  "p", "br", "h2", "h3", "h4", "h5", "h6", "em", "strong", "ul", "ol", "li", "blockquote", "pre", "code", "a",
];

/** 許可する要素・属性・URLだけを列挙する。rehype-sanitize の既定値は使わない。 */
const schema: Parameters<typeof rehypeSanitize>[0] = {
  tagNames: allowedElements,
  attributes: { a: ["href"], ol: ["start"] },
  protocols: { href: ["http", "https"] },
  ancestors: {},
  clobber: [],
  required: {},
  strip: ["script", "style"],
};

const components: Components = {
  a: ({ href, children }) => href
    ? <a href={href} rel="nofollow noopener noreferrer">{children}</a>
    : <>{children}</>,
};

function checkAndAdjust(headingLevel: HeadingLevel) {
  return () => (root: MarkdownNode) => {
    if (exceedsTreeLimits(root)) throw new RangeError("制限Markdownの上限を超えています。");
    const definitions = new Map<string, string>();
    for (const { node } of walkMarkdown(root)) {
      // 描画の処理（mdast-util-to-hast）と同じく、大文字にした名前が同じ定義は最初のものを使う。
      const name = node.identifier?.toUpperCase();
      if (node.type === "definition" && !definitions.has(name!)) definitions.set(name!, node.url!);
    }
    for (const { node } of walkMarkdown(root)) {
      if (node.type === "heading") node.depth = Math.min(6, node.depth! + headingLevel - 1);
      const url = node.type === "link" ? node.url
        : node.type === "linkReference" ? definitions.get(node.identifier!.toUpperCase()) : undefined;
      // 描画の処理がURLを書き換えた後のhrefを、検証と同じURLで置き換える。許可しないURLは空にしてリンクにしない。
      if (url !== undefined) node.data = { hProperties: { href: linkHref(url) ?? "" } };
    }
  };
}

/** 上限を超える本文では null を返す。 */
function renderMarkdown(value: string, headingLevel: HeadingLevel): ReactElement | null {
  try {
    if (exceedsParseLimits(value)) return null;
    // 解析中の失敗をここで受け止めるため、要素ではなく関数として呼ぶ（Markdown はフックを使わない同期の関数）。
    return Markdown({
      children: value,
      allowedElements,
      components,
      rehypePlugins: [[rehypeSanitize, schema]],
      remarkPlugins: [checkAndAdjust(headingLevel)] as unknown as Options["remarkPlugins"],
      skipHtml: true,
      urlTransform: (url, key) => key === "href" ? linkHref(url) : undefined,
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/**
 * Q&Aの本文の表示（画面遷移・状態遷移設計書 §3）。保存時に検証済みの本文でも、許可外の要素とURLをここで取り除く。
 * 上限を超える本文は、解析せずに文字のまま表示する。
 */
export function RestrictedMarkdown({ source, headingLevel = 3 }: RestrictedMarkdownProps) {
  const body = renderMarkdown(source, headingLevel);
  return body ? <div className={styles.body}>{body}</div> : <div className={styles.plain}>{source}</div>;
}
