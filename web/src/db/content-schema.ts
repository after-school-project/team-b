import { sql, type SQLWrapper } from "drizzle-orm";
import {
  check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { communityUsers, qaCategories } from "./schema";

const timestampWithZone = (name: string) => timestamp(name, { withTimezone: true });

function recordDates() {
  return {
    createdAt: timestampWithZone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithZone("updated_at").notNull().defaultNow(),
  };
}

function requestFields() {
  return {
    revisionId: uuid("revision_id").notNull(),
    requestKind: text("request_kind", { enum: ["new", "edit"] }).notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] }).notNull().default("pending"),
    submittedAt: timestampWithZone("submitted_at").notNull().defaultNow(),
    reviewerId: text("reviewer_id").references(() => communityUsers.userId),
    decisionReason: text("decision_reason"),
    decidedAt: timestampWithZone("decided_at"),
    withdrawalReason: text("withdrawal_reason"),
    version: integer("version").notNull().default(1),
  };
}

function requestConstraints(prefix: string, table: Record<"requestKind" | "status" | "version", SQLWrapper>) {
  return [
    check(`${prefix}_kind`, sql`${table.requestKind} IN ('new', 'edit')`),
    check(`${prefix}_status`, sql`${table.status} IN ('pending', 'approved', 'rejected', 'withdrawn')`),
    check(`${prefix}_version`, sql`${table.version} > 0`),
  ];
}

export const qaQuestions = pgTable("qa_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorId: text("author_id").notNull().references(() => communityUsers.userId),
  categoryId: uuid("category_id").notNull().references(() => qaCategories.id),
  title: text("title").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  resolution: text("resolution", { enum: ["open", "resolved"] }).notNull().default("open"),
  forcedHiddenAt: timestampWithZone("forced_hidden_at"),
  deletedAt: timestampWithZone("deleted_at"),
  authorLabel: text("author_label").notNull(),
  version: integer("version").notNull().default(1),
  ...recordDates(),
}, (table) => [
  check("qa_questions_resolution", sql`${table.resolution} IN ('open', 'resolved')`),
  check("qa_questions_version", sql`${table.version} > 0`),
  index("qa_questions_category_date").on(table.categoryId, table.createdAt, table.id),
  index("qa_questions_author_date").on(table.authorId, table.createdAt, table.id),
  index("qa_questions_public_date").on(table.createdAt, table.id)
    .where(sql`${table.deletedAt} IS NULL AND ${table.forcedHiddenAt} IS NULL`),
]);

export const qaResponses = pgTable("qa_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionId: uuid("question_id").notNull().references(() => qaQuestions.id),
  authorId: text("author_id").notNull().references(() => communityUsers.userId),
  kind: text("kind", { enum: ["answer", "comment", "reply"] }).notNull(),
  parentResponseId: uuid("parent_response_id"),
  bodyMarkdown: text("body_markdown").notNull(),
  forcedHiddenAt: timestampWithZone("forced_hidden_at"),
  deletedAt: timestampWithZone("deleted_at"),
  authorLabel: text("author_label").notNull(),
  version: integer("version").notNull().default(1),
  ...recordDates(),
}, (table) => [
  unique("qa_responses_id_question").on(table.id, table.questionId),
  foreignKey({
    name: "qa_responses_parent_question_fk",
    columns: [table.parentResponseId, table.questionId],
    foreignColumns: [table.id, table.questionId],
  }),
  check("qa_responses_parent_kind", sql`
    (${table.kind} = 'answer' AND ${table.parentResponseId} IS NULL)
    OR ${table.kind} = 'comment'
    OR (${table.kind} = 'reply' AND ${table.parentResponseId} IS NOT NULL)
  `),
  check("qa_responses_parent_not_self", sql`${table.parentResponseId} <> ${table.id}`),
  check("qa_responses_version", sql`${table.version} > 0`),
  index("qa_responses_question_date").on(table.questionId, table.createdAt, table.id),
  index("qa_responses_parent").on(table.parentResponseId, table.questionId),
  index("qa_responses_author_date").on(table.authorId, table.createdAt, table.id),
]);

export const notices = pgTable("notices", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorId: text("author_id").notNull().references(() => communityUsers.userId),
  originKind: text("origin_kind", { enum: ["school", "alumni"] }).notNull(),
  publicRevisionId: uuid("public_revision_id"),
  firstPublishedAt: timestampWithZone("first_published_at"),
  forcedHiddenAt: timestampWithZone("forced_hidden_at"),
  deletedAt: timestampWithZone("deleted_at"),
  version: integer("version").notNull().default(1),
  ...recordDates(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    name: "notices_public_revision_fk",
    columns: [table.id, table.publicRevisionId],
    foreignColumns: [noticeRevisions.noticeId, noticeRevisions.id],
  }),
  check("notices_origin", sql`${table.originKind} IN ('school', 'alumni')`),
  check("notices_version", sql`${table.version} > 0`),
  index("notices_author_date").on(table.authorId, table.updatedAt, table.id),
  index("notices_public_date").on(table.firstPublishedAt, table.id)
    .where(sql`${table.publicRevisionId} IS NOT NULL AND ${table.deletedAt} IS NULL AND ${table.forcedHiddenAt} IS NULL`),
]);

export const noticeRevisions = pgTable("notice_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  noticeId: uuid("notice_id").notNull().references(() => notices.id),
  revisionNo: integer("revision_no").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  categoryCode: text("category_code").notNull(),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  unique("notice_revisions_number").on(table.noticeId, table.revisionNo),
  unique("notice_revisions_notice_id").on(table.noticeId, table.id),
  check("notice_revisions_positive_number", sql`${table.revisionNo} > 0`),
]);

export const noticeRequests = pgTable("notice_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  noticeId: uuid("notice_id").notNull().references(() => notices.id),
  ...requestFields(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    name: "notice_requests_revision_fk",
    columns: [table.noticeId, table.revisionId],
    foreignColumns: [noticeRevisions.noticeId, noticeRevisions.id],
  }),
  uniqueIndex("notice_requests_one_pending").on(table.noticeId).where(sql`${table.status} = 'pending'`),
  index("notice_requests_status_date").on(table.status, table.submittedAt, table.id),
  index("notice_requests_notice_date").on(table.noticeId, table.submittedAt, table.id),
  ...requestConstraints("notice_requests", table),
]);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorId: text("author_id").notNull().references(() => communityUsers.userId),
  originKind: text("origin_kind", { enum: ["staff", "student", "alumni"] }).notNull(),
  publicRevisionId: uuid("public_revision_id"),
  firstPublishedAt: timestampWithZone("first_published_at"),
  cancelledAt: timestampWithZone("cancelled_at"),
  cancellationReason: text("cancellation_reason"),
  forcedHiddenAt: timestampWithZone("forced_hidden_at"),
  version: integer("version").notNull().default(1),
  ...recordDates(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    name: "events_public_revision_fk",
    columns: [table.id, table.publicRevisionId],
    foreignColumns: [eventRevisions.eventId, eventRevisions.id],
  }),
  check("events_origin", sql`${table.originKind} IN ('staff', 'student', 'alumni')`),
  check("events_version", sql`${table.version} > 0`),
  index("events_author_date").on(table.authorId, table.updatedAt, table.id),
  index("events_public_date").on(table.firstPublishedAt, table.id)
    .where(sql`${table.publicRevisionId} IS NOT NULL AND ${table.forcedHiddenAt} IS NULL`),
]);

export const eventRevisions = pgTable("event_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  revisionNo: integer("revision_no").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  startsAt: timestampWithZone("starts_at").notNull(),
  endsAt: timestampWithZone("ends_at"),
  format: text("format", { enum: ["in_person", "online", "hybrid"] }).notNull(),
  venue: text("venue"),
  participationInfo: text("participation_info"),
  externalUrl: text("external_url"),
  createdAt: timestampWithZone("created_at").notNull().defaultNow(),
}, (table) => [
  unique("event_revisions_number").on(table.eventId, table.revisionNo),
  unique("event_revisions_event_id").on(table.eventId, table.id),
  check("event_revisions_positive_number", sql`${table.revisionNo} > 0`),
  check("event_revisions_date_order", sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
  check("event_revisions_format", sql`${table.format} IN ('in_person', 'online', 'hybrid')`),
  index("event_revisions_start_date").on(table.startsAt, table.id),
]);

export const eventRequests = pgTable("event_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  ...requestFields(),
}, (table): PgTableExtraConfigValue[] => [
  foreignKey({
    name: "event_requests_revision_fk",
    columns: [table.eventId, table.revisionId],
    foreignColumns: [eventRevisions.eventId, eventRevisions.id],
  }),
  uniqueIndex("event_requests_one_pending").on(table.eventId).where(sql`${table.status} = 'pending'`),
  index("event_requests_status_date").on(table.status, table.submittedAt, table.id),
  index("event_requests_event_date").on(table.eventId, table.submittedAt, table.id),
  check("event_requests_rejection_reason", sql`
    ${table.status} <> 'rejected' OR coalesce(btrim(${table.decisionReason}), '') <> ''
  `),
  ...requestConstraints("event_requests", table),
]);
