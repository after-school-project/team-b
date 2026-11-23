import { and, asc, eq, ne, or, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { notifications } from "../db/moderation-schema";
import { communityUsers } from "../db/schema";

/**
 * 通知の記録（Issue #47 ①）。業務更新と同じトランザクションで呼ぶ。
 *
 * - `event_key` は `<kind>:<対象ID>:<契機ID>`（DB・ER設計書 §5）。`UNIQUE(recipient_id, event_key)` により、
 *   同じ操作の再送や再実行では通知を重複して作らない。
 * - 自己通知は作らない。審査依頼は、その申請を審査できる現在の管理者（申請者本人を除く）にだけ送る。
 * - `public_message` には種類ごとの定型文と、本人向けの理由だけを保存する。対象の題名・本文は保存せず、
 *   表示時に現在の権限で取得し直す（API設計書 §10）。
 *
 * 通知一覧・既読・遷移先の表示と、受信者の現在の閲覧権限の判定は #17 で行う。
 */

/** `commitMutation` の `tx` を受け取る。業務更新と同じトランザクションを渡すこと。 */
export type RecordWriter = Pick<PgDatabase<PgQueryResultHKT, Record<string, unknown>>, "select" | "insert">;

export type NotificationKind = (typeof notifications.kind.enumValues)[number];
type Decision = { decision: "approved" } | { decision: "rejected"; publicReason?: string };

/**
 * 通知の対象と契機。kind ごとに、参照する対象と `event_key` の契機IDが決まる。
 *
 * | kind | 対象（参照する列） | 契機ID |
 * |---|---|---|
 * | qa_answer_created／qa_comment_created／qa_reply_created | 作成した回答・コメント・返信（qa_response_id） | 対象と同じ |
 * | qa_hidden | 非表示にした質問（qa_question_id）または回答等（qa_response_id） | 非表示操作の監査ログID |
 * | notice_review_requested／notice_review_decided | お知らせの申請（notice_request_id） | 対象と同じ |
 * | event_review_requested／event_review_decided | イベントの申請（event_request_id） | 対象と同じ |
 * | profile_review_decided | 再公開審査（profile_review_id） | 対象と同じ |
 * | profile_hidden | 非表示にしたプロフィールの利用者（profile_user_id） | 非表示操作の監査ログID |
 *
 * 申請・審査は再申請ごとに別のレコードになるため、申請IDで再通知を区別できる。非表示は記録するレコードがほかに
 * ないため、同じトランザクションで記録した監査ログ（`recordAuditLog` の戻り値）のIDを契機にする。
 * これにより、非表示 → 再公開 → 再度の非表示でも通知を区別できる。
 */
export type NotificationSubject =
  | { kind: "qa_answer_created" | "qa_comment_created" | "qa_reply_created"; responseId: string }
  | { kind: "qa_hidden"; questionId: string; auditLogId: string; publicReason?: string }
  | { kind: "qa_hidden"; responseId: string; auditLogId: string; publicReason?: string }
  | { kind: "notice_review_requested"; noticeRequestId: string }
  | ({ kind: "notice_review_decided"; noticeRequestId: string } & Decision)
  | { kind: "event_review_requested"; eventRequestId: string }
  | ({ kind: "event_review_decided"; eventRequestId: string } & Decision)
  | ({ kind: "profile_review_decided"; profileReviewId: string } & Decision)
  | { kind: "profile_hidden"; userId: string; auditLogId: string; publicReason?: string };

export type ReviewRequestSubject = Extract<NotificationSubject, {
  kind: "notice_review_requested" | "event_review_requested";
}>;

type Reference = Pick<typeof notifications.$inferInsert,
  "qaQuestionId" | "qaResponseId" | "noticeRequestId" | "eventRequestId" | "profileReviewId" | "profileUserId">;

const fixedMessages = {
  qa_answer_created: "質問に回答が付きました。",
  qa_comment_created: "投稿にコメントが付きました。",
  qa_reply_created: "投稿に返信が付きました。",
  qa_hidden: "投稿が管理者により非表示になりました。",
  notice_review_requested: "お知らせの審査依頼が届きました。",
  event_review_requested: "イベントの審査依頼が届きました。",
  profile_hidden: "プロフィールが管理者により非表示になりました。",
} as const satisfies Partial<Record<NotificationKind, string>>;

const decisionMessages = {
  notice_review_decided: { approved: "お知らせの申請が承認されました。", rejected: "お知らせの申請が却下されました。" },
  event_review_decided: { approved: "イベントの申請が承認されました。", rejected: "イベントの申請が却下されました。" },
  profile_review_decided: {
    approved: "プロフィールの再公開が承認されました。",
    rejected: "プロフィールの再公開申請が却下されました。",
  },
} as const satisfies Partial<Record<NotificationKind, Record<Decision["decision"], string>>>;

function describe(subject: NotificationSubject): {
  reference: Reference; targetId: string; triggerId: string; message: string; publicReason?: string;
} {
  switch (subject.kind) {
    case "qa_answer_created":
    case "qa_comment_created":
    case "qa_reply_created":
      return {
        reference: { qaResponseId: subject.responseId },
        targetId: subject.responseId, triggerId: subject.responseId, message: fixedMessages[subject.kind],
      };
    case "qa_hidden": {
      const targetId = "questionId" in subject ? subject.questionId : subject.responseId;
      return {
        reference: "questionId" in subject ? { qaQuestionId: targetId } : { qaResponseId: targetId },
        targetId, triggerId: subject.auditLogId, message: fixedMessages.qa_hidden, publicReason: subject.publicReason,
      };
    }
    case "notice_review_requested":
    case "notice_review_decided":
      return {
        reference: { noticeRequestId: subject.noticeRequestId },
        targetId: subject.noticeRequestId, triggerId: subject.noticeRequestId, ...messageFor(subject),
      };
    case "event_review_requested":
    case "event_review_decided":
      return {
        reference: { eventRequestId: subject.eventRequestId },
        targetId: subject.eventRequestId, triggerId: subject.eventRequestId, ...messageFor(subject),
      };
    case "profile_review_decided":
      return {
        reference: { profileReviewId: subject.profileReviewId },
        targetId: subject.profileReviewId, triggerId: subject.profileReviewId, ...messageFor(subject),
      };
    case "profile_hidden":
      return {
        reference: { profileUserId: subject.userId },
        targetId: subject.userId, triggerId: subject.auditLogId,
        message: fixedMessages.profile_hidden, publicReason: subject.publicReason,
      };
  }
}

function messageFor(subject: NotificationSubject): { message: string; publicReason?: string } {
  if ("decision" in subject) {
    const message = decisionMessages[subject.kind as keyof typeof decisionMessages][subject.decision];
    return subject.decision === "rejected" ? { message, publicReason: subject.publicReason } : { message };
  }
  return { message: fixedMessages[subject.kind as keyof typeof fixedMessages] };
}

/** 本人向けの理由を定型文に付ける。理由は管理者が本人向けに入力した値で、対象の本文ではない。 */
function publicMessage(message: string, publicReason: string | undefined): string {
  if (publicReason === undefined) return message;
  const reason = publicReason.trim();
  if (!reason) throw new Error("通知の理由が空です。理由がない場合は省略してください。");
  return `${message}\n理由：${reason}`;
}

/** 通知の重複を防ぐキー。`<kind>:<対象ID>:<契機ID>`。 */
export function notificationEventKey(subject: NotificationSubject): string {
  const { targetId, triggerId } = describe(subject);
  return `${subject.kind}:${targetId}:${triggerId}`;
}

export type NotificationInput = {
  /** 受信者。 */
  recipientId: string;
  /** 通知のきっかけになった操作の実行者。受信者と同じなら通知しない。システム処理は null。 */
  actorId: string | null;
  subject: NotificationSubject;
  /** 記録時刻。`commitMutation` の `now` を渡す。 */
  at: Date;
};

/**
 * 通知を1件記録する。自己通知になる場合と、同じ受信者・同じ `event_key` の通知が既にある場合は何もしない。
 * 戻り値は、新しく記録したかどうか。
 */
export async function recordNotification(tx: RecordWriter, input: NotificationInput): Promise<boolean> {
  if (input.actorId !== null && input.recipientId === input.actorId) return false;
  const { reference, message, publicReason } = describe(input.subject);
  const inserted = await tx.insert(notifications).values({
    recipientId: input.recipientId,
    kind: input.subject.kind,
    ...reference,
    eventKey: notificationEventKey(input.subject),
    publicMessage: publicMessage(message, publicReason),
    createdAt: input.at,
  }).onConflictDoNothing({ target: [notifications.recipientId, notifications.eventKey] })
    .returning({ id: notifications.id });
  return inserted.length > 0;
}

/**
 * お知らせ・イベントの申請を審査できる現在の管理者。学校管理者と、停止・プロフィール非表示・権限解除の制限がない
 * アプリ管理者（`canEnterAdmin` と同じ条件）で、発行・学校確認が完了し停止していない利用者（共通認可条件表 §3）。
 * 自己審査はできないため、申請者本人を除く。
 */
function reviewerCondition(applicantId: string): SQL {
  return and(
    eq(communityUsers.provisioningStatus, "ready"),
    eq(communityUsers.eligibilityStatus, "verified"),
    eq(communityUsers.accountStatus, "active"),
    ne(communityUsers.userId, applicantId),
    or(
      eq(communityUsers.schoolManager, true),
      and(eq(communityUsers.appManager, true), eq(communityUsers.profileState, "public")),
    ),
  )!;
}

/**
 * 審査依頼を、申請を審査できる現在の管理者全員に通知する。申請者本人には送らない。
 * 戻り値は、新しく記録した通知の件数。再送などで既に記録済みの受信者は数えない。
 *
 * 審査依頼の後に管理権限が変わった受信者への表示は、通知の表示時（#17）に現在の権限で判定する。
 */
export async function recordReviewRequestNotifications(tx: RecordWriter, input: {
  applicantId: string;
  subject: ReviewRequestSubject;
  at: Date;
}): Promise<number> {
  const reviewers = await tx.select({ userId: communityUsers.userId }).from(communityUsers)
    .where(reviewerCondition(input.applicantId)).orderBy(asc(communityUsers.userId));
  let created = 0;
  for (const { userId } of reviewers) {
    if (await recordNotification(tx, {
      recipientId: userId, actorId: input.applicantId, subject: input.subject, at: input.at,
    })) created += 1;
  }
  return created;
}
