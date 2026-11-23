import { createHash, randomUUID } from "node:crypto";
import { eq, like, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notificationEventKey, notificationValues, type NotificationSubject } from "../src/api/notifications";
import {
  eventRequests, eventRevisions, events, noticeRequests, noticeRevisions, notices, qaQuestions, qaResponses,
} from "../src/db/content-schema";
import {
  auditLogs, evidenceSnapshots, notifications, operationReceipts, reportActions, reportCaseEvidence,
  reportCases, reportTargets, reports,
} from "../src/db/moderation-schema";
import { graduationChanges, managerRoleChanges, qaCategories } from "../src/db/schema";

type SeedTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
const demoQuestionId = "3f11e8d7-925d-4cdd-af58-354378699ded";

/**
 * #47 より前の seed が保存した旧形式のキー（`qa-answer:<回答ID>` など）を、`<kind>:<対象ID>:<契機ID>` へ更新する。
 * 同じ行を更新するため、通知のIDと既読状態は変わらない。旧形式のキーは seed だけが作るため、それ以外の通知は変えない。
 */
export async function upgradeLegacySeedNotificationKeys(tx: SeedTransaction): Promise<number> {
  const rows = await tx.select().from(notifications).where(or(
    like(notifications.eventKey, "qa-answer:%"),
    like(notifications.eventKey, "notice-request:%"),
    like(notifications.eventKey, "event-request:%"),
  ));
  let updated = 0;
  for (const row of rows) {
    let subject: NotificationSubject | null = null;
    if (row.kind === "qa_answer_created" && row.qaResponseId && row.eventKey === `qa-answer:${row.qaResponseId}`) {
      subject = { kind: row.kind, responseId: row.qaResponseId };
    } else if (row.kind === "notice_review_requested" && row.noticeRequestId && row.eventKey === `notice-request:${row.noticeRequestId}`) {
      subject = { kind: row.kind, noticeRequestId: row.noticeRequestId };
    } else if (row.kind === "event_review_requested" && row.eventRequestId && row.eventKey === `event-request:${row.eventRequestId}`) {
      subject = { kind: row.kind, eventRequestId: row.eventRequestId };
    }
    if (!subject) continue;
    await tx.update(notifications).set({ eventKey: notificationEventKey(subject) }).where(eq(notifications.id, row.id));
    updated += 1;
  }
  return updated;
}

export async function seedCommunityContent(tx: SeedTransaction, userIds: ReadonlyMap<string, string>) {
  // The question, its references, and the rest of the sample data are inserted in one transaction.
  const [existing] = await tx.select({ id: qaQuestions.id }).from(qaQuestions)
    .where(eq(qaQuestions.id, demoQuestionId));
  if (existing) {
    // 既に投入済みの開発DBでも、旧形式のキーで保存した seed の通知を現在の形式へ揃える（#47）。
    await upgradeLegacySeedNotificationKeys(tx);
    return;
  }

  function userId(username: string) {
    const id = userIds.get(username);
    if (!id) throw new Error(`Missing community fixture account: ${username}`);
    return id;
  }

  const student = userId("poc_s001");
  const alumni = userId("poc_a001");
  const staff = userId("poc_staff");
  const schoolManager = userId("poc_school");
  const publishedAt = new Date();
  const [category] = await tx.select({ id: qaCategories.id }).from(qaCategories)
    .where(eq(qaCategories.code, "learning"));
  if (!category) throw new Error("Missing learning category.");

  const questionInput = {
    title: "チーム開発で最初に揃えておくとよいことは？",
    bodyMarkdown: "初めてチームでWebアプリを作ります。開発環境やレビューの進め方を教えてください。",
    categoryCode: "learning",
  };
  await tx.insert(qaQuestions).values({
    id: demoQuestionId,
    authorId: student,
    authorLabel: "はる",
    categoryId: category.id,
    title: questionInput.title,
    bodyMarkdown: questionInput.bodyMarkdown,
    resolution: "resolved",
  });
  const [answer] = await tx.insert(qaResponses).values({
    questionId: demoQuestionId, authorId: alumni, authorLabel: "あおい", kind: "answer",
    bodyMarkdown: "起動手順とテスト用データを共有して、全員が同じ手順で動かせるか確かめると進めやすいです。",
  }).returning({ id: qaResponses.id });
  const [comment] = await tx.insert(qaResponses).values({
    questionId: demoQuestionId, authorId: student, authorLabel: "はる", kind: "comment",
    parentResponseId: answer.id, bodyMarkdown: "まず起動手順をREADMEに書いてみます。",
  }).returning({ id: qaResponses.id });
  await tx.insert(qaResponses).values({
    questionId: demoQuestionId, authorId: alumni, authorLabel: "あおい", kind: "reply",
    parentResponseId: comment.id, bodyMarkdown: "手順を別のメンバーに試してもらうと抜けを見つけやすいですよ。",
  });

  const [{ id: schoolNoticeId }] = await tx.insert(notices).values({ authorId: staff, originKind: "school" })
    .returning({ id: notices.id });
  const [{ id: alumniNoticeId }] = await tx.insert(notices).values({ authorId: alumni, originKind: "alumni" })
    .returning({ id: notices.id });
  const [schoolRevision] = await tx.insert(noticeRevisions).values({
    noticeId: schoolNoticeId, revisionNo: 1, title: "開発環境オリエンテーション",
    body: "チーム開発の手順を確認します。開始前に開発環境を起動してください。", categoryCode: "general",
  }).returning({ id: noticeRevisions.id });
  const [publicRevision] = await tx.insert(noticeRevisions).values({
    noticeId: alumniNoticeId, revisionNo: 1, title: "卒業生とのキャリア相談",
    body: "就職活動や現場の話を聞ける相談会を予定しています。", categoryCode: "general",
  }).returning({ id: noticeRevisions.id });
  const [pendingRevision] = await tx.insert(noticeRevisions).values({
    noticeId: alumniNoticeId, revisionNo: 2, title: "卒業生とのキャリア相談（詳細追記）",
    body: "希望者は質問を事前にまとめておいてください。", categoryCode: "general",
  }).returning({ id: noticeRevisions.id });
  await tx.update(notices).set({ publicRevisionId: schoolRevision.id, firstPublishedAt: publishedAt })
    .where(eq(notices.id, schoolNoticeId));
  await tx.update(notices).set({ publicRevisionId: publicRevision.id, firstPublishedAt: publishedAt })
    .where(eq(notices.id, alumniNoticeId));
  await tx.insert(noticeRequests).values({
    noticeId: alumniNoticeId, revisionId: publicRevision.id, requestKind: "new",
    status: "approved", reviewerId: schoolManager, decidedAt: publishedAt,
  });
  const [noticeRequest] = await tx.insert(noticeRequests).values({
    noticeId: alumniNoticeId, revisionId: pendingRevision.id, requestKind: "edit",
  }).returning({ id: noticeRequests.id });

  const day = 24 * 60 * 60 * 1_000;
  const [publicEvent] = await tx.insert(events).values({ authorId: staff, originKind: "staff" })
    .returning({ id: events.id });
  const [publicEventRevision] = await tx.insert(eventRevisions).values({
    eventId: publicEvent.id, revisionNo: 1, title: "学校と卒業生の交流会",
    description: "在校生と卒業生で最近の制作について話します。", format: "in_person", venue: "実習室A（架空）",
    startsAt: new Date(publishedAt.getTime() + 7 * day),
  }).returning({ id: eventRevisions.id });
  await tx.update(events).set({ publicRevisionId: publicEventRevision.id, firstPublishedAt: publishedAt })
    .where(eq(events.id, publicEvent.id));
  const [pendingEvent] = await tx.insert(events).values({ authorId: student, originKind: "student" })
    .returning({ id: events.id });
  const [pendingEventRevision] = await tx.insert(eventRevisions).values({
    eventId: pendingEvent.id, revisionNo: 1, title: "在校生の制作もくもく会",
    description: "各自の制作を進め、最後に作業内容を共有します。", format: "online",
    participationInfo: "当日の案内に記載したオンライン会議に参加してください。",
    startsAt: new Date(publishedAt.getTime() + 14 * day),
  }).returning({ id: eventRevisions.id });
  const [eventRequest] = await tx.insert(eventRequests).values({
    eventId: pendingEvent.id, revisionId: pendingEventRevision.id, requestKind: "new",
  }).returning({ id: eventRequests.id });

  const [target] = await tx.insert(reportTargets).values({ kind: "question", questionId: demoQuestionId })
    .returning({ id: reportTargets.id });
  const [reportCase] = await tx.insert(reportCases).values({
    targetId: target.id, status: "in_progress", priority: "normal", assigneeId: schoolManager,
  }).returning({ id: reportCases.id });
  await tx.insert(reports).values({
    caseId: reportCase.id, reporterId: userId("poc_s002"), reasonCode: "other",
    detail: "開発環境での通報対応確認用です。",
  });
  const [evidence] = await tx.insert(evidenceSnapshots).values({
    targetId: target.id, sourceRevision: 1,
    snapshot: { title: questionInput.title, bodyMarkdown: questionInput.bodyMarkdown },
  }).returning({ id: evidenceSnapshots.id });
  await tx.insert(reportCaseEvidence).values({ caseId: reportCase.id, evidenceId: evidence.id });
  await tx.insert(reportActions).values({
    caseId: reportCase.id, actorId: schoolManager, actionType: "status_changed",
    beforeState: { status: "unhandled" }, afterState: { status: "in_progress" },
    note: "サンプル案件を確認中です。",
  });
  await tx.insert(auditLogs).values({
    actorId: schoolManager, actionType: "report_case.status_changed", targetType: "report_case", targetId: reportCase.id,
    beforeState: { status: "unhandled" }, afterState: { status: "in_progress" },
  });

  // 通知の値は業務処理と同じ共通処理で作り、event_key と public_message の形式を揃える（#47）。
  // seed は並行する更新のない1つのトランザクションで投入するため、受信者の行ロックを取らずに保存する。
  const seededNotifications = [
    notificationValues({
      recipientId: student, actorId: alumni, subject: { kind: "qa_answer_created", responseId: answer.id }, at: publishedAt,
    }),
    notificationValues({
      recipientId: schoolManager, actorId: alumni,
      subject: { kind: "notice_review_requested", noticeRequestId: noticeRequest.id }, at: publishedAt,
    }),
    notificationValues({
      recipientId: schoolManager, actorId: student,
      subject: { kind: "event_review_requested", eventRequestId: eventRequest.id }, at: publishedAt,
    }),
  ];
  await tx.insert(notifications).values(seededNotifications.filter((values) => values !== null));
  await tx.insert(managerRoleChanges).values({
    userId: userId("poc_s_mgr"), actorId: schoolManager, beforeAppManager: false, afterAppManager: true,
  });
  await tx.insert(graduationChanges).values({
    batchId: randomUUID(), userId: alumni, actorId: schoolManager, changeKind: "graduation",
    beforeRole: "student", afterRole: "alumni", beforeGraduating: true, afterGraduating: false,
  });
  await tx.insert(operationReceipts).values({
    actorId: student, requestKey: "dev-seed-question-1",
    requestHash: createHash("sha256").update(JSON.stringify({
      method: "POST", path: "/api/v1/questions", body: questionInput,
    })).digest("hex"),
    resultType: "question", resultId: demoQuestionId, resultVersion: 1, resultState: "public", responseStatus: 201,
  });
}
