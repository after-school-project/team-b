import { describe, expect, it } from "vitest";
import { auditOperations } from "../../src/api/audit-log";
import { notificationEventKey, type NotificationSubject } from "../../src/api/notifications";

describe("通知の event_key（#47 ①、DB・ER設計書 §5）", () => {
  const target = "11111111-1111-4111-8111-111111111111";
  const trigger = "22222222-2222-4222-8222-222222222222";

  it.each<[NotificationSubject, string]>([
    [{ kind: "qa_answer_created", responseId: target }, `qa_answer_created:${target}:${target}`],
    [{ kind: "qa_comment_created", responseId: target }, `qa_comment_created:${target}:${target}`],
    [{ kind: "qa_reply_created", responseId: target }, `qa_reply_created:${target}:${target}`],
    [{ kind: "qa_hidden", questionId: target, auditLogId: trigger }, `qa_hidden:${target}:${trigger}`],
    [{ kind: "qa_hidden", responseId: target, auditLogId: trigger }, `qa_hidden:${target}:${trigger}`],
    [{ kind: "notice_review_requested", noticeRequestId: target }, `notice_review_requested:${target}:${target}`],
    [{ kind: "notice_review_decided", noticeRequestId: target, decision: "approved" },
      `notice_review_decided:${target}:${target}`],
    [{ kind: "event_review_requested", eventRequestId: target }, `event_review_requested:${target}:${target}`],
    [{ kind: "event_review_decided", eventRequestId: target, decision: "rejected", publicReason: "日時の誤り" },
      `event_review_decided:${target}:${target}`],
    [{ kind: "profile_review_decided", profileReviewId: target, decision: "rejected" },
      `profile_review_decided:${target}:${target}`],
    [{ kind: "profile_hidden", userId: "user-1", auditLogId: trigger }, `profile_hidden:user-1:${trigger}`],
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

describe("監査ログの許可リスト（#47 ②）", () => {
  it("秘密値・投稿本文・本人確認情報・任意プロフィール項目を許可していない", () => {
    const forbidden = [
      "password", "passwordHash", "token", "secret", "bodyMarkdown", "body", "title",
      "privateRealName", "schoolReference", "bio", "occupation", "interests", "optionalValues",
    ];
    for (const { fields } of Object.values(auditOperations)) {
      for (const field of fields) expect(forbidden).not.toContain(field);
    }
  });
});
