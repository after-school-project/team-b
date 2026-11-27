import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResponseThread } from "@/app/questions/[questionId]/response-thread";
import { noCapabilities } from "@/auth/capabilities";
import type { ResponseView } from "@/qa/responses";

/** 回答・コメント・返信のスレッド（QA-02、#9 ③④）。一覧APIのフラットな配列から親子関係を組み立てて表示する。 */

const at = "2026-11-20T15:30:00.000Z";

function shown(id: string, kind: ResponseView["kind"], parentResponseId: string | null, body: string,
  capabilities: Partial<ResponseView["capabilities"]> = {}): ResponseView {
  return {
    id, questionId: "q", parentResponseId, kind, publicationState: "public", content: { bodyMarkdown: body },
    author: { userId: `u-${id}`, displayName: `著者${id}` }, version: 1, createdAt: at, updatedAt: at,
    capabilities: { ...noCapabilities, ...capabilities },
  };
}

function withheld(id: string, publicationState: "hidden" | "deleted", parentResponseId: string | null = null): ResponseView {
  return {
    id, questionId: "q", parentResponseId, kind: "answer", publicationState, content: null, author: null, version: null,
    createdAt: null, updatedAt: null, capabilities: { ...noCapabilities },
  };
}

const render = (items: ResponseView[], options: { canAnswer?: boolean; unavailableReason?: string | null; nextCursor?: string | null } = {}) =>
  renderToStaticMarkup(createElement(ResponseThread, {
    questionId: "q", initial: { items, nextCursor: options.nextCursor ?? null },
    canAnswer: options.canAnswer ?? false, unavailableReason: options.unavailableReason ?? null,
  }));

describe("回答・コメント・返信のスレッド", () => {
  it("AC-05 親子関係を入れ子の一覧で表示し、投稿の種類を示す", () => {
    const html = render([
      shown("a", "answer", null, "回答の本文"),
      shown("c", "comment", "a", "コメントの本文"),
      shown("r", "reply", "c", "返信の本文"),
      shown("qc", "comment", null, "質問へのコメント"),
    ]);
    const answer = html.indexOf('id="response-a"');
    const comment = html.indexOf('id="response-c"');
    const reply = html.indexOf('id="response-r"');
    const questionComment = html.indexOf('id="response-qc"');
    expect([answer, comment, reply, questionComment].every((index) => index >= 0)).toBe(true);
    expect(answer < comment && comment < reply && reply < questionComment).toBe(true);
    // 回答の下にコメント、コメントの下に返信が入れ子になる。質問へのコメントは最上位に戻る。
    const nested = html.slice(answer, questionComment);
    expect(nested.match(/<ol/g)).toHaveLength(2);
    expect(nested.match(/<\/ol><\/li><\/ol><\/li>/g)).toHaveLength(1);
    for (const text of ["回答", "コメント", "返信", "著者a", 'href="/users/u-a"', "2026/11/21 0:30"]) expect(html).toContain(text);
  });

  it("AC-06 削除済み・閲覧できない投稿は状態だけを表示し、残存する子の投稿は表示する", () => {
    const html = render([withheld("d", "deleted"), withheld("h", "hidden"), shown("r", "reply", "d", "残存する返信")]);
    expect(html).toContain("この回答は削除されました。");
    expect(html).toContain("この回答は現在表示できません。");
    expect(html).toContain("残存する返信");
    expect(html.indexOf("この回答は削除されました。")).toBeLessThan(html.indexOf("残存する返信"));
    expect(html.indexOf("残存する返信")).toBeLessThan(html.indexOf("この回答は現在表示できません。"));
  });

  it("本文は制限Markdownとして表示し、生HTMLを描画しない", () => {
    const html = render([shown("a", "answer", null, "# 見出し\n\n**強調** <b>生HTML</b>")]);
    expect(html).toContain("<h3>見出し</h3>");
    expect(html).toContain("<strong>強調</strong>");
    expect(html).not.toContain("<b>");
  });

  it("返信先が読み込まれていない投稿は最上位に表示する", () => {
    expect(render([shown("r", "reply", "missing", "返信の本文")])).toContain("返信の本文");
  });

  it("操作の入口は capabilities に従い、回答にはコメント、コメント・返信には返信を付ける", () => {
    const html = render([
      shown("a", "answer", null, "回答", { canRespond: true, canEdit: true }),
      shown("c", "comment", "a", "コメント", { canRespond: true }),
      shown("x", "answer", null, "操作なし"),
    ]);
    expect(html.match(/>コメントする</g)).toHaveLength(1);
    expect(html.match(/>返信する</g)).toHaveLength(1);
    expect(html.match(/>回答を編集</g)).toHaveLength(1);
    expect(html).not.toContain("コメントを編集");
  });

  it("AC-09 削除の入口は canDelete の投稿だけに出し、確認ダイアログの中身は開くまで描画しない", () => {
    const html = render([
      shown("a", "answer", null, `長い回答${"あ".repeat(80)}`, { canDelete: true }),
      shown("r", "reply", "a", "返信\n\n2段落目", { canDelete: true }),
      shown("x", "comment", null, "他人のコメント", { canRespond: true }),
    ]);
    expect(html.match(/>回答を削除</g)).toHaveLength(1);
    expect(html.match(/>返信を削除</g)).toHaveLength(1);
    expect(html).not.toContain("コメントを削除");
    expect(html.match(/<dialog/g)).toHaveLength(2);
    // 閉じたダイアログに本文の冒頭を置くと、画面の本文と重複して検索・読み上げされるため、開くまで出さない。
    expect(html).not.toContain(`長い回答${"あ".repeat(56)}…`);
    expect(html).not.toContain(">削除する<");
  });

  it("回答できる質問には回答フォームを、できない質問には理由を表示する", () => {
    const open = render([], { canAnswer: true });
    expect(open).toContain("まだ回答・コメントはありません。");
    expect(open).toContain("回答を投稿");
    expect(open).toContain("質問にコメントする");
    expect(open).toContain("10,000文字以内");
    const closed = render([], { unavailableReason: "この質問には新しい回答・コメントを投稿できません。" });
    expect(closed).not.toContain("回答を投稿");
    expect(closed).toContain("この質問には新しい回答・コメントを投稿できません。");
  });

  it("続きがあるときだけ「さらに表示」を表示する", () => {
    expect(render([shown("a", "answer", null, "回答")], { nextCursor: "next" })).toContain("さらに表示");
    expect(render([shown("a", "answer", null, "回答")])).not.toContain("さらに表示");
  });
});
