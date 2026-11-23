import { describe, expect, it } from "vitest";
import { auditOperations } from "../../src/api/audit-log";
import { notificationEventKey, notificationValues, type NotificationSubject } from "../../src/api/notifications";

const target = "11111111-1111-4111-8111-111111111111";
const trigger = "22222222-2222-4222-8222-222222222222";
const at = new Date("2026-11-24T00:00:00Z");

describe("通知の event_key（#47 ①、DB・ER設計書 §5）", () => {
  it.each<[NotificationSubject, string]>([
    [{ kind: "qa_answer_created", responseId: target }, `qa_answer_created:${target}:${target}`],
    [{ kind: "qa_comment_created", responseId: target }, `qa_comment_created:${target}:${target}`],
    [{ kind: "qa_reply_created", responseId: target }, `qa_reply_created:${target}:${target}`],
    [{ kind: "qa_hidden", questionId: target, auditLogId: trigger, publicReason: "理由" }, `qa_hidden:${target}:${trigger}`],
    [{ kind: "qa_hidden", responseId: target, auditLogId: trigger, publicReason: "理由" }, `qa_hidden:${target}:${trigger}`],
    [{ kind: "notice_review_requested", noticeRequestId: target }, `notice_review_requested:${target}:${target}`],
    [{ kind: "notice_review_decided", noticeRequestId: target, decision: "approved" },
      `notice_review_decided:${target}:${target}`],
    [{ kind: "event_review_requested", eventRequestId: target }, `event_review_requested:${target}:${target}`],
    [{ kind: "event_review_decided", eventRequestId: target, decision: "rejected", publicReason: "日時の誤り" },
      `event_review_decided:${target}:${target}`],
    [{ kind: "profile_review_decided", profileReviewId: target, decision: "rejected", publicReason: "理由" },
      `profile_review_decided:${target}:${target}`],
    [{ kind: "profile_hidden", userId: "user-1", auditLogId: trigger, publicReason: "理由" }, `profile_hidden:user-1:${trigger}`],
  ])("%o は %s", (subject, expected) => {
    expect(notificationEventKey(subject)).toBe(expected);
  });

  it("理由や判定結果は event_key に含めない", () => {
    expect(notificationEventKey({ kind: "profile_review_decided", profileReviewId: target, decision: "approved" }))
      .toBe(notificationEventKey({
        kind: "profile_review_decided", profileReviewId: target, decision: "rejected", publicReason: "理由",
      }));
  });
});

describe("通知の本文と理由（#47 ①、API設計書 §11）", () => {
  const values = (subject: NotificationSubject, actorId: string | null = "admin") =>
    notificationValues({ recipientId: "user-1", actorId, subject, at });

  it("受信者と実行者が同じなら通知を作らない", () => {
    expect(values({ kind: "qa_answer_created", responseId: target }, "user-1")).toBeNull();
    expect(values({ kind: "qa_answer_created", responseId: target }, null)).not.toBeNull();
  });

  it("本人向けの理由を定型文の後に付ける", () => {
    expect(values({ kind: "profile_hidden", userId: "user-1", auditLogId: trigger, publicReason: " 連絡先の掲載 " })?.publicMessage)
      .toBe("プロフィールが管理者により非表示になりました。\n理由：連絡先の掲載");
    expect(values({ kind: "notice_review_decided", noticeRequestId: target, decision: "rejected" })?.publicMessage)
      .toBe("お知らせの申請が却下されました。");
  });

  it.each<[string, Record<string, unknown>]>([
    ["プロフィールの非表示", { kind: "profile_hidden", userId: "user-1", auditLogId: trigger }],
    ["Q&Aの非表示", { kind: "qa_hidden", questionId: target, auditLogId: trigger }],
    ["Q&Aの回答等の非表示", { kind: "qa_hidden", responseId: target, auditLogId: trigger, publicReason: " " }],
    ["プロフィール再公開の却下", { kind: "profile_review_decided", profileReviewId: target, decision: "rejected" }],
    ["イベント申請の却下", { kind: "event_review_decided", eventRequestId: target, decision: "rejected", publicReason: "" }],
    ["理由が null のプロフィールの非表示", { kind: "profile_hidden", userId: "user-1", auditLogId: trigger, publicReason: null }],
    ["理由が null のイベント申請の却下",
      { kind: "event_review_decided", eventRequestId: target, decision: "rejected", publicReason: null }],
  ])("%s は理由がなければ保存しない", (_name, subject) => {
    expect(() => values(subject as NotificationSubject)).toThrow("本人向けの理由が必要です");
  });

  it("理由が任意の通知は、省略と未入力を正規化した null のどちらも定型文だけを保存する", () => {
    for (const publicReason of [undefined, null]) {
      expect(values({ kind: "notice_review_decided", noticeRequestId: target, decision: "rejected", publicReason })
        ?.publicMessage).toBe("お知らせの申請が却下されました。");
    }
  });

  it("理由が任意の通知でも、空の理由は保存しない", () => {
    expect(() => values({ kind: "notice_review_decided", noticeRequestId: target, decision: "rejected", publicReason: " " }))
      .toThrow("理由が空です");
  });

  it("承認の通知には理由を付けない", () => {
    const subject = { kind: "event_review_decided", eventRequestId: target, decision: "approved", publicReason: "メモ" };
    expect(values(subject as NotificationSubject)?.publicMessage).toBe("イベントの申請が承認されました。");
  });
});

describe("監査ログの許可リスト（#47 ②）", () => {
  it("秘密値・投稿本文・本人確認情報・任意プロフィール項目を許可していない", () => {
    const forbidden = [
      "password", "passwordHash", "token", "secret", "bodyMarkdown", "body", "title",
      "privateRealName", "schoolReference", "bio", "occupation", "interests", "optionalValues",
    ];
    for (const { fields } of Object.values(auditOperations)) {
      for (const field of Object.keys(fields)) expect(forbidden).not.toContain(field);
    }
  });
});
