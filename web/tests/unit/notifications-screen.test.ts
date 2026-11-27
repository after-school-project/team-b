import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  canOpenTarget, isAppPath, kindLabels, pendingScreenNote, splitMessage, targetStateNotes,
} from "@/app/notifications/labels";
import { notificationStates, readNotificationParams } from "@/app/notifications/notification-filters";
import { NotificationList } from "@/app/notifications/notification-list";
import type { NotificationListEntry } from "@/notifications/notifications";

/** 通知一覧（GE-06）の表示（#17 ②）。 */
describe("通知一覧の条件", () => {
  it("state は未指定・空欄・all を「すべて」とし、URLに残さない", () => {
    for (const params of [{}, { state: "" }, { state: " " }, { state: "all" }]) {
      const { state, query, malformed } = readNotificationParams(params);
      expect([state, query.toString(), malformed]).toEqual(["all", "", false]);
    }
  });

  it("未読のみとカーソルを API のクエリーに渡し、ほかのクエリーは無視する", () => {
    const { state, query, malformed } = readNotificationParams({ state: "unread", cursor: "c", other: "x" });
    expect([state, query.toString(), malformed]).toEqual(["unread", "state=unread&cursor=c", false]);
  });

  it("定義していない state と同名の複数指定は、形式の誤りとして扱う", () => {
    expect(readNotificationParams({ state: "read" }).malformed).toBe(true);
    expect(readNotificationParams({ state: ["all", "unread"] }).malformed).toBe(true);
    expect(readNotificationParams({ cursor: ["a", "b"] }).malformed).toBe(true);
  });

  it("絞り込みの選択肢は「すべて」「未読のみ」の順", () => {
    expect(notificationStates.map(({ label, href }) => [label, href])).toEqual([
      ["すべて", "/notifications"], ["未読のみ", "/notifications?state=unread"],
    ]);
  });
});

describe("通知の文面", () => {
  it("1行目の定型文と、2行目以降の本人向けの理由に分ける", () => {
    expect(splitMessage("質問に回答が付きました。")).toEqual({ summary: "質問に回答が付きました。", detail: null });
    expect(splitMessage("投稿が管理者により非表示になりました。\n理由：個人情報\n2行目"))
      .toEqual({ summary: "投稿が管理者により非表示になりました。", detail: "理由：個人情報\n2行目" });
    expect(splitMessage("定型文\n")).toEqual({ summary: "定型文", detail: null });
  });

  it("すべての種類にラベルがある", () => {
    expect(Object.keys(kindLabels).sort()).toEqual([
      "event_review_decided", "event_review_requested", "notice_review_decided", "notice_review_requested",
      "profile_hidden", "profile_review_decided", "qa_answer_created", "qa_comment_created", "qa_hidden",
      "qa_reply_created",
    ]);
  });
});

describe("通知の遷移先", () => {
  it("同一アプリの相対パスだけを遷移先として受け付ける", () => {
    for (const path of ["/questions/1#response-2", "/me/notices?notice=1&request=2", "/me/profile"]) {
      expect(isAppPath(path)).toBe(true);
    }
    for (const path of ["https://example.com/", "//example.com/", "/\\example.com", "javascript:alert(1)", "", null, 1]) {
      expect(isAppPath(path)).toBe(false);
    }
  });
});

describe("通知の一覧", () => {
  const unread: NotificationListEntry = {
    id: "00000000-0000-4000-8000-000000000001", kind: "qa_hidden",
    message: "投稿が管理者により非表示になりました。\n理由：<b>個人情報</b>を含むため",
    createdAt: "2026-11-26T03:00:00.000Z", readAt: null, targetState: "available", screenPending: false,
  };
  const read: NotificationListEntry = {
    id: "00000000-0000-4000-8000-000000000002", kind: "notice_review_requested",
    message: "お知らせの審査依頼が届きました。", createdAt: "2026-11-25T03:00:00.000Z", readAt: "2026-11-25T04:00:00.000Z",
    targetState: "withdrawn", screenPending: false,
  };
  const render = (items: NotificationListEntry[]) =>
    renderToStaticMarkup(createElement(NotificationList, { items, headingId: "notification-results" }));

  it("未読は「未読」ラベルと太字の文面で示し、通知の文面を説明に持つ「既読にする」を表示する", () => {
    const html = render([unread]);
    expect(html).toContain(">未読</span>");
    expect(html).toContain(">Q&amp;A</span>");
    expect(html).toMatch(/<p id="notification-00000000-0000-4000-8000-000000000001" class="[^"]*messageUnread[^"]*">/);
    expect(html).toMatch(/<button type="button"[^>]*aria-describedby="notification-00000000-0000-4000-8000-000000000001"[^>]*>既読にする<\/button>/);
    expect(html).toContain("<time dateTime=\"2026-11-26T03:00:00.000Z\">");
  });

  it("本人向けの理由はテキストとして表示し、HTMLとして解釈しない", () => {
    const html = render([unread]);
    expect(html).toContain("理由：&lt;b&gt;個人情報&lt;/b&gt;を含むため");
    expect(html).not.toContain("<b>");
  });

  it("既読は「既読」ラベルで示し、既読にする操作を表示しない", () => {
    const html = render([read]);
    expect(html).toContain(">既読</span>");
    expect(html).toContain(">お知らせ</span>");
    expect(html).not.toContain("既読にする");
    expect(html).not.toContain("未読");
  });

  it("遷移できる通知には、通知の文面を説明に持つ「対象を表示する」を表示する", () => {
    expect(render([unread])).toMatch(/<button type="button"[^>]*aria-describedby="notification-00000000-0000-4000-8000-000000000001"[^>]*>対象を表示する<\/button>/);
  });

  it.each(["deleted", "hidden"] as const)("%s の通知には文面に加えて状態案内を表示し、「対象を表示する」を表示しない", (state) => {
    const html = render([{ ...unread, kind: "qa_answer_created", message: "質問に回答が付きました。", targetState: state }]);
    expect(html).toContain("質問に回答が付きました。");
    expect(html).toContain(targetStateNotes[state]);
    expect(html).not.toContain("対象を表示する");
  });

  it.each(["not_available", "withdrawn", "expired"] as const)(
    "%s の通知は、サーバーが返した状態案内の文面だけを表示し、同じ案内を重ねない", (state) => {
      const html = render([{ ...read, message: targetStateNotes[state], targetState: state }]);
      expect(html.split(targetStateNotes[state])).toHaveLength(2);
      expect(html).not.toContain("対象を表示する");
    });

  it.each(["event_review_requested", "event_review_decided"] as const)(
    "遷移先の画面が未実装の %s は、保存した文面と準備中の案内を表示し、「対象を表示する」を出さない", (kind) => {
      // 資格のある閲覧者：サーバーは not_available と screenPending を返し、保存した文面を残す。
      const html = render([{ ...unread, kind, message: "定型文", targetState: "not_available", screenPending: true }]);
      expect(html).toContain("定型文");
      expect(html).toContain(pendingScreenNote);
      expect(html).not.toContain("対象を表示する");
      expect(html).toContain("既読にする");
      // サーバーが available を返した場合も、画面がなければ遷移させない。
      expect(canOpenTarget(kind, "available")).toBe(false);
    });

  it.each(["notice_review_requested", "event_review_requested", "event_review_decided"] as const)(
    "同じ %s でも、資格を失った通知には汎用の案内文だけを表示し、準備中と案内しない", (kind) => {
      const html = render([{ ...unread, kind, message: targetStateNotes.not_available, targetState: "not_available", screenPending: false }]);
      expect(html).toContain(targetStateNotes.not_available);
      expect(html).not.toContain(pendingScreenNote);
      expect(html).not.toContain("対象を表示する");
    });

  it("遷移先の画面がある種類の not_available には、準備中の案内を出さない", () => {
    const html = render([{ ...read, kind: "profile_hidden", message: targetStateNotes.not_available, targetState: "not_available" }]);
    expect(html).not.toContain(pendingScreenNote);
  });

  it.each([
    "qa_answer_created", "qa_comment_created", "qa_reply_created", "qa_hidden", "notice_review_requested", "notice_review_decided",
    "profile_review_decided", "profile_hidden",
  ] as const)("遷移先の画面がある %s は「対象を表示する」を出す", (kind) => {
    expect(canOpenTarget(kind, "available")).toBe(true);
    expect(canOpenTarget(kind, "deleted")).toBe(false);
  });

  it("既読の案内を読み上げる領域を、一覧の前に空のまま用意する", () => {
    expect(render([unread, read])).toMatch(/^<div role="status"><\/div><ul/);
  });
});
