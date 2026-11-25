import { z } from "zod";
import { longText, shortText } from "@/api/request";
import { markdownProblems, type MarkdownProblem } from "./restricted-markdown";

/** 画面に表示する、保存できない理由。 */
export const markdownProblemMessages: Record<MarkdownProblem, string> = {
  too_complex: "引用・箇条書きの入れ子、行数、または記号（* _ [ <）が多すぎます。減らしてください。",
  html: "HTMLのタグは使えません。文字として載せる場合は、コード（`）で囲んでください。",
  url: "リンクのURLは、http:// または https:// で始めてください。",
  image: "画像は使えません。",
};

// pipe は、空白だけ・文字数の検証に失敗した値を渡さない。長すぎる本文を解析しないために使う。
const restricted = z.string().superRefine((value, context) => {
  for (const problem of markdownProblems(value)) {
    context.addIssue({
      code: "custom",
      params: { fieldError: { code: `markdown_${problem}`, message: markdownProblemMessages[problem] } },
    });
  }
});

/** 質問・回答の本文（API設計書 §3 LongText の制限Markdown）。 */
export const longMarkdown = longText.pipe(restricted);

/** コメント・返信の本文（API設計書 §3 ShortText の制限Markdown）。 */
export const shortMarkdown = shortText.pipe(restricted);
