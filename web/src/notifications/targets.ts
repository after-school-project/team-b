import { eq, sql } from "drizzle-orm";
import { alias, type SelectedFields } from "drizzle-orm/pg-core";
import type { NotificationKind } from "@/api/notifications";
import { canEnterAdmin, type AccessReader, type Viewer } from "@/auth/access";
import { hasAdminScope, scopeForTarget } from "@/auth/admin";
import { deletedNoticeRetentionDays } from "@/auth/visibility";
import { eventRequests, events, noticeRequests, notices, qaQuestions, qaResponses } from "@/db/content-schema";
import { notifications } from "@/db/moderation-schema";
import { communityUsers, profileReviews } from "@/db/schema";

/**
 * 通知の対象の状態と遷移先（API-NT-04、NotificationView.targetState）。Issue #17 ③。
 *
 * - 対象を見る資格は、通知を作った時点ではなく、取得のたびに閲覧者の現在の状態で判定する。
 *   管理権限の解除などで資格を失った通知は `not_available` とし、対象の具体的な状態（取り下げ・削除など）も返さない。
 * - 遷移先は、通知の種類と対象のIDから、サーバーで同一アプリの相対パスを組み立てる。保存値のURLは使わない。
 *   パスを返すのは `available` だけ。遷移先の画面でも、画面側の認可を改めて行う（画面遷移設計書 §4）。
 * - 対象の題名・本文は読まない。判定に必要な所有者・状態・日時だけを読む。
 */

/** API設計書 §5 NavigationTarget.state。 */
export type TargetState = "available" | "withdrawn" | "deleted" | "hidden" | "expired" | "not_available";

/** API設計書 §5 NavigationTarget。 */
export type NavigationTarget = { state: TargetState; path: string | null };

/** 対象を見る資格がない通知の文面。保存した定型文・本人向けの理由の代わりに返す（API設計書 §5 NotificationView）。 */
export const unavailableMessage = "この通知の対象は、現在の権限では表示できません。";

const questionTarget = alias(qaQuestions, "target_question");
const responseTarget = alias(qaResponses, "target_response");
const responseAuthor = alias(communityUsers, "target_response_author");

/**
 * 通知と、対象の判定に使う列。対象の参照先を左結合して、通知1件につき1行で読む。
 * 一覧（API-NT-01）と遷移先の取得（API-NT-04）で、同じ列・同じ判定を使う。
 */
const notificationTargetColumns = {
  id: notifications.id,
  kind: notifications.kind,
  message: notifications.publicMessage,
  createdAt: notifications.createdAt,
  readAt: notifications.readAt,
  questionId: questionTarget.id,
  questionAuthorId: questionTarget.authorId,
  questionDeletedAt: questionTarget.deletedAt,
  responseId: responseTarget.id,
  responseQuestionId: responseTarget.questionId,
  responseAuthorId: responseTarget.authorId,
  responseHiddenAt: responseTarget.forcedHiddenAt,
  responseDeletedAt: responseTarget.deletedAt,
  responseAuthorSchoolManager: responseAuthor.schoolManager,
  responseAuthorAppManager: responseAuthor.appManager,
  noticeRequestId: noticeRequests.id,
  noticeRequestStatus: noticeRequests.status,
  noticeId: notices.id,
  noticeAuthorId: notices.authorId,
  noticeDeletedAt: notices.deletedAt,
  // 削除済みお知らせの保存期間内か。DBの現在時刻で判定する（`retainedDeletedNotice` と同じ基準）。
  noticeRetained: sql<boolean | null>`(${notices.deletedAt} > now() - make_interval(days => ${deletedNoticeRetentionDays}))`,
  eventRequestId: eventRequests.id,
  eventRequestStatus: eventRequests.status,
  eventId: events.id,
  eventAuthorId: events.authorId,
  profileReviewUserId: profileReviews.userId,
  profileUserId: notifications.profileUserId,
};

/** 通知を、対象の判定に必要な参照先と一緒に読むクエリー。条件・並び順は呼び出し側で付ける。 */
export function selectNotificationsWithTargets<T extends SelectedFields>(reader: AccessReader, extra: T) {
  return reader.select({ ...notificationTargetColumns, ...extra }).from(notifications)
    .leftJoin(questionTarget, eq(questionTarget.id, notifications.qaQuestionId))
    .leftJoin(responseTarget, eq(responseTarget.id, notifications.qaResponseId))
    .leftJoin(responseAuthor, eq(responseAuthor.userId, responseTarget.authorId))
    .leftJoin(noticeRequests, eq(noticeRequests.id, notifications.noticeRequestId))
    .leftJoin(notices, eq(notices.id, noticeRequests.noticeId))
    .leftJoin(eventRequests, eq(eventRequests.id, notifications.eventRequestId))
    .leftJoin(events, eq(events.id, eventRequests.eventId))
    .leftJoin(profileReviews, eq(profileReviews.id, notifications.profileReviewId));
}

/** `resolveNotificationTarget` が使う行。`selectNotificationsWithTargets` の結果を渡す。 */
export type NotificationTargetRow = {
  kind: NotificationKind;
  questionId: string | null;
  questionAuthorId: string | null;
  questionDeletedAt: Date | null;
  responseId: string | null;
  responseQuestionId: string | null;
  responseAuthorId: string | null;
  responseHiddenAt: Date | null;
  responseDeletedAt: Date | null;
  responseAuthorSchoolManager: boolean | null;
  responseAuthorAppManager: boolean | null;
  noticeRequestId: string | null;
  noticeRequestStatus: "pending" | "approved" | "rejected" | "withdrawn" | null;
  noticeId: string | null;
  noticeAuthorId: string | null;
  noticeDeletedAt: Date | null;
  noticeRetained: boolean | null;
  eventRequestId: string | null;
  eventRequestStatus: "pending" | "approved" | "rejected" | "withdrawn" | null;
  eventId: string | null;
  eventAuthorId: string | null;
  profileReviewUserId: string | null;
  profileUserId: string | null;
};

const notAvailable: NavigationTarget = { state: "not_available", path: null };

function stateOnly(state: Exclude<TargetState, "available">): NavigationTarget {
  return { state, path: null };
}

function available(path: string): NavigationTarget {
  return { state: "available", path };
}

const segment = encodeURIComponent;

/**
 * 通知の対象の現在の状態と遷移先を判定する。閲覧者は、通知の受信者本人で停止していない最新の Viewer を渡す。
 *
 * 種類ごとの判定（宛先は DB・ER設計書「通知の生成」に従う）。
 * - Q&Aの回答・コメント・返信（宛先は親投稿の投稿者）：QA-02 の該当投稿。削除済みは deleted。
 *   強制非表示は、投稿者本人か当該投稿を管理できる管理者だけ遷移でき、それ以外は hidden（QA-02 と同じ投影）。
 *   親質問の削除・非表示は、残存する投稿への遷移を妨げない（API設計書 §5）。
 * - Q&Aの非表示（宛先は投稿者本人）：本人は非表示中も QA-02 で自分の投稿を見られる。削除済みは deleted。
 * - お知らせ・イベントの審査依頼（宛先は審査できる管理者）：現在も審査できる管理者だけ AD-05／AD-07 へ遷移できる。
 *   取り下げ済みの申請は withdrawn、削除済みのお知らせは deleted。申請本文は返さない。
 * - お知らせ・イベントの審査結果（宛先は申請者）：本人の申請履歴（NO-05／EV-05）。
 *   削除済みのお知らせは、保存期間内なら deleted、期限後は expired。
 * - プロフィールの審査結果・非表示（宛先は本人）：GE-02。
 *
 * 受信者と対象の所有者が一致しないなど、想定外の組み合わせは not_available とし、対象の状態を返さない。
 */
export function resolveNotificationTarget(viewer: Viewer, row: NotificationTargetRow): NavigationTarget {
  switch (row.kind) {
    case "qa_answer_created":
    case "qa_comment_created":
    case "qa_reply_created": {
      if (row.responseId === null || row.responseQuestionId === null) return notAvailable;
      if (row.responseDeletedAt !== null) return stateOnly("deleted");
      if (row.responseHiddenAt !== null) {
        const own = row.responseAuthorId === viewer.userId;
        const manageable = hasAdminScope(viewer, scopeForTarget({
          schoolManager: row.responseAuthorSchoolManager === true, appManager: row.responseAuthorAppManager === true,
        }));
        if (!own && !manageable) return stateOnly("hidden");
      }
      return available(responsePath(row.responseQuestionId, row.responseId));
    }
    case "qa_hidden": {
      if (row.questionId !== null) {
        if (row.questionAuthorId !== viewer.userId) return notAvailable;
        if (row.questionDeletedAt !== null) return stateOnly("deleted");
        return available(`/questions/${segment(row.questionId)}`);
      }
      if (row.responseId === null || row.responseQuestionId === null) return notAvailable;
      if (row.responseAuthorId !== viewer.userId) return notAvailable;
      if (row.responseDeletedAt !== null) return stateOnly("deleted");
      return available(responsePath(row.responseQuestionId, row.responseId));
    }
    case "notice_review_requested": {
      if (row.noticeRequestId === null || row.noticeId === null) return notAvailable;
      // 審査できる管理者の条件は、審査依頼の宛先（reviewerCondition）と同じ。自己審査はできない。
      if (!canEnterAdmin(viewer) || row.noticeAuthorId === viewer.userId) return notAvailable;
      if (row.noticeRequestStatus === "withdrawn") return stateOnly("withdrawn");
      if (row.noticeDeletedAt !== null) return stateOnly("deleted");
      return available(`/admin/notices/${segment(row.noticeId)}?request=${segment(row.noticeRequestId)}`);
    }
    case "notice_review_decided": {
      if (row.noticeRequestId === null || row.noticeId === null) return notAvailable;
      if (row.noticeAuthorId !== viewer.userId) return notAvailable;
      if (row.noticeDeletedAt !== null) return stateOnly(row.noticeRetained === true ? "deleted" : "expired");
      return available(`/me/notices?notice=${segment(row.noticeId)}&request=${segment(row.noticeRequestId)}`);
    }
    case "event_review_requested": {
      if (row.eventRequestId === null || row.eventId === null) return notAvailable;
      if (!canEnterAdmin(viewer) || row.eventAuthorId === viewer.userId) return notAvailable;
      if (row.eventRequestStatus === "withdrawn") return stateOnly("withdrawn");
      return available(`/admin/events/${segment(row.eventId)}?request=${segment(row.eventRequestId)}`);
    }
    case "event_review_decided": {
      if (row.eventRequestId === null || row.eventId === null) return notAvailable;
      if (row.eventAuthorId !== viewer.userId) return notAvailable;
      return available(`/me/events?event=${segment(row.eventId)}&request=${segment(row.eventRequestId)}`);
    }
    case "profile_review_decided":
      return row.profileReviewUserId === viewer.userId ? available("/me/profile") : notAvailable;
    case "profile_hidden":
      return row.profileUserId === viewer.userId ? available("/me/profile") : notAvailable;
  }
}

function responsePath(questionId: string, responseId: string): string {
  return `/questions/${segment(questionId)}#response-${segment(responseId)}`;
}
