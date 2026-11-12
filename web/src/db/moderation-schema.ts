import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { eventRequests, noticeRequests, qaQuestions, qaResponses } from "./content-schema";
import { communityUsers, profileReviews } from "./schema";

const timestampWithZone = (name: string) => timestamp(name, { withTimezone: true });

export const reportTargets = pgTable("report_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["account", "profile", "question", "response"] }).notNull(),
  subjectUserId: text("subject_user_id").references(() => communityUsers.userId),
  questionId: uuid("question_id").references(() => qaQuestions.id),
  responseId: uuid("response_id").references(() => qaResponses.id),
}, (table) => [
  check("report_targets_reference", sql`
    num_nonnulls(${table.subjectUserId}, ${table.questionId}, ${table.responseId}) = 1
    AND (
      (${table.kind} IN ('account', 'profile') AND ${table.subjectUserId} IS NOT NULL)
      OR (${table.kind} = 'question' AND ${table.questionId} IS NOT NULL)
      OR (${table.kind} = 'response' AND ${table.responseId} IS NOT NULL)
    )
  `),
  unique("report_targets_user_kind").on(table.subjectUserId, table.kind),
  unique("report_targets_question").on(table.questionId),
  unique("report_targets_response").on(table.responseId),
]);

export const reportCases = pgTable("report_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetId: uuid("target_id").notNull().references(() => reportTargets.id),
  status: text("status", { enum: ["unhandled", "in_progress", "closed"] }).notNull().default("unhandled"),
  priority: text("priority", { enum: ["unset", "normal", "high"] }).notNull().default("unset"),
  assigneeId: text("assignee_id").references(() => communityUsers.userId),
  handoffPending: boolean("handoff_pending").notNull().default(false),
  schoolOnly: boolean("school_only").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithZone("updated_at").notNull().defaultNow(),
  closedAt: timestampWithZone("closed_at"),
}, (table) => [
  check("report_cases_status", sql`${table.status} IN ('unhandled', 'in_progress', 'closed')`),
  check("report_cases_priority", sql`${table.priority} IN ('unset', 'normal', 'high')`),
  check("report_cases_assignment", sql`${table.handoffPending} = (${table.assigneeId} IS NULL)`),
  check("report_cases_closure", sql`
    (${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)
    AND (${table.status} <> 'closed' OR NOT ${table.handoffPending})
  `),
  check("report_cases_version", sql`${table.version} > 0`),
  uniqueIndex("report_cases_one_active").on(table.targetId)
    .where(sql`${table.status} IN ('unhandled', 'in_progress')`),
  index("report_cases_target").on(table.targetId),
  index("report_cases_assignee_status").on(table.assigneeId, table.status),
]);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => reportCases.id),
  reporterId: text("reporter_id").notNull().references(() => communityUsers.userId),
  reasonCode: text("reason_code", {
    enum: ["harassment", "personal_information", "spam", "suspicious_url", "inappropriate_recruitment", "other"],
  }).notNull(),
  detail: text("detail"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  check("reports_reason", sql`${table.reasonCode} IN (
    'harassment', 'personal_information', 'spam', 'suspicious_url', 'inappropriate_recruitment', 'other'
  )`),
  check("reports_detail", sql`
    char_length(${table.detail}) <= 500
    OR (${table.detail} IS NULL AND ${table.reasonCode} <> 'other')
  `),
  check("reports_other_detail", sql`${table.reasonCode} <> 'other' OR coalesce(btrim(${table.detail}), '') <> ''`),
  index("reports_case_date").on(table.caseId, table.createdAt, table.id),
  index("reports_reporter").on(table.reporterId),
]);

export const reportActions = pgTable("report_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => reportCases.id),
  actorId: text("actor_id").references(() => communityUsers.userId),
  systemAction: boolean("system_action").notNull().default(false),
  actionType: text("action_type").notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>(),
  note: text("note"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  check("report_actions_actor", sql`${table.systemAction} OR ${table.actorId} IS NOT NULL`),
  index("report_actions_case_date").on(table.caseId, table.createdAt, table.id),
]);

export const evidenceSnapshots = pgTable("evidence_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetId: uuid("target_id").notNull().references(() => reportTargets.id),
  sourceRevision: integer("source_revision").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  capturedAt: timestampWithZone("captured_at").notNull().defaultNow(),
}, (table) => [
  check("evidence_snapshots_revision", sql`${table.sourceRevision} > 0`),
  index("evidence_snapshots_target_date").on(table.targetId, table.capturedAt, table.id),
]);

export const reportCaseEvidence = pgTable("report_case_evidence", {
  caseId: uuid("case_id").notNull().references(() => reportCases.id),
  evidenceId: uuid("evidence_id").notNull().references(() => evidenceSnapshots.id),
}, (table) => [
  primaryKey({ columns: [table.caseId, table.evidenceId] }),
  index("report_case_evidence_snapshot").on(table.evidenceId),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipientId: text("recipient_id").notNull().references(() => communityUsers.userId),
  kind: text("kind", {
    enum: [
      "qa_answer_created", "qa_comment_created", "qa_reply_created", "qa_hidden",
      "notice_review_requested", "notice_review_decided", "event_review_requested", "event_review_decided",
      "profile_review_decided", "profile_hidden",
    ],
  }).notNull(),
  qaQuestionId: uuid("qa_question_id").references(() => qaQuestions.id),
  qaResponseId: uuid("qa_response_id").references(() => qaResponses.id),
  noticeRequestId: uuid("notice_request_id").references(() => noticeRequests.id),
  eventRequestId: uuid("event_request_id").references(() => eventRequests.id),
  profileReviewId: uuid("profile_review_id").references(() => profileReviews.id),
  profileUserId: text("profile_user_id").references(() => communityUsers.userId),
  eventKey: text("event_key").notNull(),
  publicMessage: text("public_message").notNull(),
  readAt: timestampWithZone("read_at"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  unique("notifications_recipient_event").on(table.recipientId, table.eventKey),
  check("notifications_reference", sql`
    num_nonnulls(${table.qaQuestionId}, ${table.qaResponseId}, ${table.noticeRequestId},
      ${table.eventRequestId}, ${table.profileReviewId}, ${table.profileUserId}) = 1
    AND (
      (${table.kind} IN ('qa_answer_created', 'qa_comment_created', 'qa_reply_created') AND ${table.qaResponseId} IS NOT NULL)
      OR (${table.kind} = 'qa_hidden' AND (${table.qaQuestionId} IS NOT NULL OR ${table.qaResponseId} IS NOT NULL))
      OR (${table.kind} IN ('notice_review_requested', 'notice_review_decided') AND ${table.noticeRequestId} IS NOT NULL)
      OR (${table.kind} IN ('event_review_requested', 'event_review_decided') AND ${table.eventRequestId} IS NOT NULL)
      OR (${table.kind} = 'profile_review_decided' AND ${table.profileReviewId} IS NOT NULL)
      OR (${table.kind} = 'profile_hidden' AND ${table.profileUserId} IS NOT NULL)
    )
  `),
  index("notifications_recipient_date").on(table.recipientId, table.createdAt, table.id),
  index("notifications_recipient_unread").on(table.recipientId).where(sql`${table.readAt} IS NULL`),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").references(() => communityUsers.userId),
  systemAction: boolean("system_action").notNull().default(false),
  actionType: text("action_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>(),
  publicReason: text("public_reason"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  check("audit_logs_actor", sql`${table.systemAction} OR ${table.actorId} IS NOT NULL`),
  index("audit_logs_date").on(table.createdAt, table.id),
  index("audit_logs_target_date").on(table.targetType, table.targetId, table.createdAt),
]);

export const operationReceipts = pgTable("operation_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").notNull().references(() => communityUsers.userId),
  requestKey: text("request_key").notNull(),
  requestHash: text("request_hash").notNull(),
  resultType: text("result_type").notNull(),
  resultId: text("result_id").notNull(),
  resultVersion: integer("result_version"),
  resultState: text("result_state").notNull(),
  responseStatus: integer("response_status").notNull(),
  affectedCount: integer("affected_count"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  unique("operation_receipts_actor_key").on(table.actorId, table.requestKey),
  check("operation_receipts_key", sql`${table.requestKey} ~ '^[a-zA-Z0-9_-]{8,128}$'`),
  check("operation_receipts_success_status", sql`${table.responseStatus} IN (200, 201)`),
]);
