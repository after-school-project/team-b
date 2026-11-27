import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "../../src/auth/access";
import type { NotificationTargetRow } from "../../src/notifications/targets";

vi.mock("server-only", () => ({}));
vi.mock("../../src/auth/server", () => ({ getAuthSession: vi.fn() }));

const { resolveNotificationTarget } = await import("../../src/notifications/targets");

/** 通知の対象の状態と遷移先（#17 ③、API-NT-04・NotificationView.targetState）。DB を使わない判定の確認。 */

const me = "user-me";
const other = "user-other";
const questionId = "11111111-1111-4111-8111-111111111111";
const responseId = "22222222-2222-4222-8222-222222222222";
const noticeId = "33333333-3333-4333-8333-333333333333";
const noticeRequestId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const eventRequestId = "66666666-6666-4666-8666-666666666666";
const at = new Date("2026-11-01T00:00:00Z");

function viewer(roles: Partial<Viewer["roles"]> = {}, profileState: Viewer["profileState"] = "public"): Viewer {
  return {
    userId: me, baseRole: "alumni", isGraduating: false, profileState, userVersion: 1,
    roles: { schoolManager: false, appManager: false, ...roles },
  };
}

const empty: NotificationTargetRow = {
  kind: "profile_hidden",
  questionId: null, questionAuthorId: null, questionDeletedAt: null,
  responseId: null, responseQuestionId: null, responseAuthorId: null, responseHiddenAt: null, responseDeletedAt: null,
  responseAuthorSchoolManager: null, responseAuthorAppManager: null,
  noticeRequestId: null, noticeRequestStatus: null, noticeId: null, noticeAuthorId: null, noticeDeletedAt: null,
  noticeRetained: null,
  eventRequestId: null, eventRequestStatus: null, eventId: null, eventAuthorId: null,
  profileReviewUserId: null, profileUserId: null,
};

function responseRow(kind: NotificationTargetRow["kind"], values: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return {
    ...empty, kind, responseId, responseQuestionId: questionId, responseAuthorId: other,
    responseAuthorSchoolManager: false, responseAuthorAppManager: false, ...values,
  };
}

function noticeRow(kind: NotificationTargetRow["kind"], values: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return { ...empty, kind, noticeRequestId, noticeRequestStatus: "pending", noticeId, noticeAuthorId: other, ...values };
}

function eventRow(kind: NotificationTargetRow["kind"], values: Partial<NotificationTargetRow> = {}): NotificationTargetRow {
  return { ...empty, kind, eventRequestId, eventRequestStatus: "pending", eventId, eventAuthorId: other, ...values };
}

const responsePath = `/questions/${questionId}#response-${responseId}`;

describe("Q&Aの回答・コメント・返信の通知", () => {
  it.each(["qa_answer_created", "qa_comment_created", "qa_reply_created"] as const)(
    "%s：公開中の投稿は QA-02 の該当投稿へ遷移できる", (kind) => {
      expect(resolveNotificationTarget(viewer(), responseRow(kind))).toEqual({ state: "available", path: responsePath });
    });

  it("削除済みの投稿は deleted で、パスを返さない", () => {
    expect(resolveNotificationTarget(viewer(), responseRow("qa_answer_created", { responseDeletedAt: at })))
      .toEqual({ state: "deleted", path: null });
  });

  it("強制非表示の投稿は、一般の受信者には hidden で、パスを返さない", () => {
    expect(resolveNotificationTarget(viewer(), responseRow("qa_comment_created", { responseHiddenAt: at })))
      .toEqual({ state: "hidden", path: null });
  });

  it("強制非表示の投稿でも、当該投稿を管理できる管理者は遷移できる", () => {
    const row = responseRow("qa_reply_created", { responseHiddenAt: at });
    expect(resolveNotificationTarget(viewer({ appManager: true }), row).state).toBe("available");
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), row).state).toBe("available");
  });

  it("投稿者がアプリ管理者の強制非表示の投稿は、アプリ管理者には hidden、学校管理者は遷移できる", () => {
    const row = responseRow("qa_answer_created", { responseHiddenAt: at, responseAuthorAppManager: true });
    expect(resolveNotificationTarget(viewer({ appManager: true }), row).state).toBe("hidden");
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), row).state).toBe("available");
  });

  it("プロフィール非表示中のアプリ管理者は管理者として扱わない", () => {
    const row = responseRow("qa_answer_created", { responseHiddenAt: at });
    expect(resolveNotificationTarget(viewer({ appManager: true }, "hidden"), row).state).toBe("hidden");
  });
});

describe("Q&Aの非表示の通知", () => {
  it("投稿者本人は、非表示中の自分の質問へ遷移できる", () => {
    const row = { ...empty, kind: "qa_hidden" as const, questionId, questionAuthorId: me };
    expect(resolveNotificationTarget(viewer(), row)).toEqual({ state: "available", path: `/questions/${questionId}` });
  });

  it("投稿者本人は、非表示中の自分の回答へ遷移できる。削除済みなら deleted", () => {
    const row = responseRow("qa_hidden", { responseAuthorId: me, responseHiddenAt: at });
    expect(resolveNotificationTarget(viewer(), row)).toEqual({ state: "available", path: responsePath });
    expect(resolveNotificationTarget(viewer(), { ...row, responseDeletedAt: at })).toEqual({ state: "deleted", path: null });
  });

  it("削除済みの質問は deleted", () => {
    const row = { ...empty, kind: "qa_hidden" as const, questionId, questionAuthorId: me, questionDeletedAt: at };
    expect(resolveNotificationTarget(viewer(), row)).toEqual({ state: "deleted", path: null });
  });

  it("受信者が投稿者でなければ not_available で、対象の状態を返さない", () => {
    const row = { ...empty, kind: "qa_hidden" as const, questionId, questionAuthorId: other, questionDeletedAt: at };
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), row)).toEqual({ state: "not_available", path: null });
  });
});

describe("お知らせ・イベントの審査依頼の通知", () => {
  it("審査できる管理者は AD-05／AD-07 の申請へ遷移できる", () => {
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), noticeRow("notice_review_requested")))
      .toEqual({ state: "available", path: `/admin/notices/${noticeId}?request=${noticeRequestId}` });
    expect(resolveNotificationTarget(viewer({ appManager: true }), eventRow("event_review_requested")))
      .toEqual({ state: "available", path: `/admin/events/${eventId}?request=${eventRequestId}` });
  });

  it("審査済みの申請も、審査できる管理者は遷移できる", () => {
    const row = noticeRow("notice_review_requested", { noticeRequestStatus: "approved" });
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), row).state).toBe("available");
  });

  it("取り下げ済みの申請は withdrawn だけを返す", () => {
    expect(resolveNotificationTarget(viewer({ schoolManager: true }),
      noticeRow("notice_review_requested", { noticeRequestStatus: "withdrawn" }))).toEqual({ state: "withdrawn", path: null });
    expect(resolveNotificationTarget(viewer({ schoolManager: true }),
      eventRow("event_review_requested", { eventRequestStatus: "withdrawn" }))).toEqual({ state: "withdrawn", path: null });
  });

  it("削除済みのお知らせは deleted", () => {
    const row = noticeRow("notice_review_requested", { noticeDeletedAt: at, noticeRetained: true });
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), row)).toEqual({ state: "deleted", path: null });
  });

  it.each([
    ["管理権限を解除された利用者", viewer()],
    ["プロフィール非表示中のアプリ管理者", viewer({ appManager: true }, "hidden")],
  ])("%sは not_available で、取り下げなどの具体的な状態も返さない", (_label, subject) => {
    for (const status of ["pending", "withdrawn"] as const) {
      expect(resolveNotificationTarget(subject, noticeRow("notice_review_requested", { noticeRequestStatus: status })))
        .toEqual({ state: "not_available", path: null });
      expect(resolveNotificationTarget(subject, eventRow("event_review_requested", { eventRequestStatus: status })))
        .toEqual({ state: "not_available", path: null });
    }
  });

  it("自分の申請の審査依頼は not_available（自己審査の禁止）", () => {
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), noticeRow("notice_review_requested", { noticeAuthorId: me })).state)
      .toBe("not_available");
    expect(resolveNotificationTarget(viewer({ appManager: true }), eventRow("event_review_requested", { eventAuthorId: me })).state)
      .toBe("not_available");
  });
});

describe("お知らせ・イベントの審査結果の通知", () => {
  it("申請者本人は、申請履歴（NO-05／EV-05）へ遷移できる", () => {
    expect(resolveNotificationTarget(viewer(), noticeRow("notice_review_decided", { noticeAuthorId: me, noticeRequestStatus: "rejected" })))
      .toEqual({ state: "available", path: `/me/notices?notice=${noticeId}&request=${noticeRequestId}` });
    expect(resolveNotificationTarget(viewer(), eventRow("event_review_decided", { eventAuthorId: me, eventRequestStatus: "approved" })))
      .toEqual({ state: "available", path: `/me/events?event=${eventId}&request=${eventRequestId}` });
  });

  it("削除済みのお知らせは、保存期間内なら deleted、期限後は expired", () => {
    const row = noticeRow("notice_review_decided", { noticeAuthorId: me, noticeDeletedAt: at });
    expect(resolveNotificationTarget(viewer(), { ...row, noticeRetained: true })).toEqual({ state: "deleted", path: null });
    expect(resolveNotificationTarget(viewer(), { ...row, noticeRetained: false })).toEqual({ state: "expired", path: null });
  });

  it("受信者が申請者でなければ not_available", () => {
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), noticeRow("notice_review_decided")).state).toBe("not_available");
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), eventRow("event_review_decided")).state).toBe("not_available");
  });
});

describe("プロフィールの通知", () => {
  it("本人のプロフィールの審査結果・非表示は GE-02 へ遷移できる", () => {
    expect(resolveNotificationTarget(viewer(), { ...empty, kind: "profile_review_decided", profileReviewUserId: me }))
      .toEqual({ state: "available", path: "/me/profile" });
    expect(resolveNotificationTarget(viewer({}, "hidden"), { ...empty, kind: "profile_hidden", profileUserId: me }))
      .toEqual({ state: "available", path: "/me/profile" });
  });

  it("他人のプロフィールの通知は not_available", () => {
    expect(resolveNotificationTarget(viewer(), { ...empty, kind: "profile_review_decided", profileReviewUserId: other }).state)
      .toBe("not_available");
    expect(resolveNotificationTarget(viewer(), { ...empty, kind: "profile_hidden", profileUserId: other }).state)
      .toBe("not_available");
  });
});

describe("参照先がない通知", () => {
  it.each([
    "qa_answer_created", "qa_hidden", "notice_review_requested", "notice_review_decided",
    "event_review_requested", "event_review_decided",
  ] as const)("%s は not_available", (kind) => {
    expect(resolveNotificationTarget(viewer({ schoolManager: true }), { ...empty, kind }))
      .toEqual({ state: "not_available", path: null });
  });
});
