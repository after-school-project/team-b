CREATE TABLE "graduation_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"change_kind" text NOT NULL,
	"before_role" text NOT NULL,
	"after_role" text NOT NULL,
	"before_graduating" boolean NOT NULL,
	"after_graduating" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graduation_changes_batch_user" UNIQUE("batch_id","user_id"),
	CONSTRAINT "graduation_changes_roles" CHECK (
    "graduation_changes"."before_role" IN ('student', 'alumni') AND "graduation_changes"."after_role" IN ('student', 'alumni')
    AND (NOT "graduation_changes"."before_graduating" OR "graduation_changes"."before_role" = 'student')
    AND (NOT "graduation_changes"."after_graduating" OR "graduation_changes"."after_role" = 'student')
  ),
	CONSTRAINT "graduation_changes_kind" CHECK (
    "graduation_changes"."change_kind" = 'correction'
    OR ("graduation_changes"."change_kind" = 'graduation' AND "graduation_changes"."before_graduating" AND "graduation_changes"."after_role" = 'alumni')
  )
);
--> statement-breakpoint
CREATE TABLE "manager_role_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"before_app_manager" boolean NOT NULL,
	"after_app_manager" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manager_role_changes_changed" CHECK ("manager_role_changes"."before_app_manager" <> "manager_role_changes"."after_app_manager")
);
--> statement-breakpoint
CREATE TABLE "event_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"request_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"withdrawal_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "event_requests_rejection_reason" CHECK (
    "event_requests"."status" <> 'rejected' OR coalesce(btrim("event_requests"."decision_reason"), '') <> ''
  ),
	CONSTRAINT "event_requests_kind" CHECK ("event_requests"."request_kind" IN ('new', 'edit')),
	CONSTRAINT "event_requests_status" CHECK ("event_requests"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "event_requests_version" CHECK ("event_requests"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"format" text NOT NULL,
	"venue" text,
	"participation_info" text,
	"external_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_revisions_number" UNIQUE("event_id","revision_no"),
	CONSTRAINT "event_revisions_event_id" UNIQUE("event_id","id"),
	CONSTRAINT "event_revisions_positive_number" CHECK ("event_revisions"."revision_no" > 0),
	CONSTRAINT "event_revisions_date_order" CHECK ("event_revisions"."ends_at" IS NULL OR "event_revisions"."ends_at" > "event_revisions"."starts_at"),
	CONSTRAINT "event_revisions_format" CHECK ("event_revisions"."format" IN ('in_person', 'online', 'hybrid'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" text NOT NULL,
	"origin_kind" text NOT NULL,
	"public_revision_id" uuid,
	"first_published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"forced_hidden_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_origin" CHECK ("events"."origin_kind" IN ('staff', 'student', 'alumni')),
	CONSTRAINT "events_version" CHECK ("events"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notice_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notice_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"request_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"withdrawal_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "notice_requests_kind" CHECK ("notice_requests"."request_kind" IN ('new', 'edit')),
	CONSTRAINT "notice_requests_status" CHECK ("notice_requests"."status" IN ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "notice_requests_version" CHECK ("notice_requests"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notice_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notice_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_revisions_number" UNIQUE("notice_id","revision_no"),
	CONSTRAINT "notice_revisions_notice_id" UNIQUE("notice_id","id"),
	CONSTRAINT "notice_revisions_positive_number" CHECK ("notice_revisions"."revision_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" text NOT NULL,
	"origin_kind" text NOT NULL,
	"public_revision_id" uuid,
	"first_published_at" timestamp with time zone,
	"forced_hidden_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_origin" CHECK ("notices"."origin_kind" IN ('school', 'alumni')),
	CONSTRAINT "notices_version" CHECK ("notices"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "qa_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" text NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"forced_hidden_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"author_label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_questions_resolution" CHECK ("qa_questions"."resolution" IN ('open', 'resolved')),
	CONSTRAINT "qa_questions_version" CHECK ("qa_questions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "qa_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_response_id" uuid,
	"body_markdown" text NOT NULL,
	"forced_hidden_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"author_label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_responses_id_question" UNIQUE("id","question_id"),
	CONSTRAINT "qa_responses_parent_kind" CHECK (
    ("qa_responses"."kind" = 'answer' AND "qa_responses"."parent_response_id" IS NULL)
    OR "qa_responses"."kind" = 'comment'
    OR ("qa_responses"."kind" = 'reply' AND "qa_responses"."parent_response_id" IS NOT NULL)
  ),
	CONSTRAINT "qa_responses_parent_not_self" CHECK ("qa_responses"."parent_response_id" <> "qa_responses"."id"),
	CONSTRAINT "qa_responses_version" CHECK ("qa_responses"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text,
	"system_action" boolean DEFAULT false NOT NULL,
	"action_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"public_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor" CHECK ("audit_logs"."system_action" OR "audit_logs"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_snapshots_revision" CHECK ("evidence_snapshots"."source_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" text NOT NULL,
	"kind" text NOT NULL,
	"qa_question_id" uuid,
	"qa_response_id" uuid,
	"notice_request_id" uuid,
	"event_request_id" uuid,
	"profile_review_id" uuid,
	"profile_user_id" text,
	"event_key" text NOT NULL,
	"public_message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_event" UNIQUE("recipient_id","event_key"),
	CONSTRAINT "notifications_reference" CHECK (
    num_nonnulls("notifications"."qa_question_id", "notifications"."qa_response_id", "notifications"."notice_request_id",
      "notifications"."event_request_id", "notifications"."profile_review_id", "notifications"."profile_user_id") = 1
    AND (
      ("notifications"."kind" IN ('qa_answer_created', 'qa_comment_created', 'qa_reply_created') AND "notifications"."qa_response_id" IS NOT NULL)
      OR ("notifications"."kind" = 'qa_hidden' AND ("notifications"."qa_question_id" IS NOT NULL OR "notifications"."qa_response_id" IS NOT NULL))
      OR ("notifications"."kind" IN ('notice_review_requested', 'notice_review_decided') AND "notifications"."notice_request_id" IS NOT NULL)
      OR ("notifications"."kind" IN ('event_review_requested', 'event_review_decided') AND "notifications"."event_request_id" IS NOT NULL)
      OR ("notifications"."kind" = 'profile_review_decided' AND "notifications"."profile_review_id" IS NOT NULL)
      OR ("notifications"."kind" = 'profile_hidden' AND "notifications"."profile_user_id" IS NOT NULL)
    )
  )
);
--> statement-breakpoint
CREATE TABLE "operation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_type" text NOT NULL,
	"result_id" text NOT NULL,
	"result_version" integer,
	"result_state" text NOT NULL,
	"response_status" integer NOT NULL,
	"affected_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_receipts_actor_key" UNIQUE("actor_id","request_key"),
	CONSTRAINT "operation_receipts_key" CHECK ("operation_receipts"."request_key" ~ '^[a-zA-Z0-9_-]{8,128}$'),
	CONSTRAINT "operation_receipts_success_status" CHECK ("operation_receipts"."response_status" IN (200, 201))
);
--> statement-breakpoint
CREATE TABLE "report_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" text,
	"system_action" boolean DEFAULT false NOT NULL,
	"action_type" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_actions_actor" CHECK ("report_actions"."system_action" OR "report_actions"."actor_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "report_case_evidence" (
	"case_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	CONSTRAINT "report_case_evidence_case_id_evidence_id_pk" PRIMARY KEY("case_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "report_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'unhandled' NOT NULL,
	"priority" text DEFAULT 'unset' NOT NULL,
	"assignee_id" text,
	"handoff_pending" boolean DEFAULT false NOT NULL,
	"school_only" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "report_cases_status" CHECK ("report_cases"."status" IN ('unhandled', 'in_progress', 'closed')),
	CONSTRAINT "report_cases_priority" CHECK ("report_cases"."priority" IN ('unset', 'normal', 'high')),
	CONSTRAINT "report_cases_assignment" CHECK ("report_cases"."handoff_pending" = ("report_cases"."assignee_id" IS NULL)),
	CONSTRAINT "report_cases_closure" CHECK (
    ("report_cases"."status" = 'closed') = ("report_cases"."closed_at" IS NOT NULL)
    AND ("report_cases"."status" <> 'closed' OR NOT "report_cases"."handoff_pending")
  ),
	CONSTRAINT "report_cases_version" CHECK ("report_cases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "report_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_user_id" text,
	"question_id" uuid,
	"response_id" uuid,
	CONSTRAINT "report_targets_user_kind" UNIQUE("subject_user_id","kind"),
	CONSTRAINT "report_targets_question" UNIQUE("question_id"),
	CONSTRAINT "report_targets_response" UNIQUE("response_id"),
	CONSTRAINT "report_targets_reference" CHECK (
    num_nonnulls("report_targets"."subject_user_id", "report_targets"."question_id", "report_targets"."response_id") = 1
    AND (
      ("report_targets"."kind" IN ('account', 'profile') AND "report_targets"."subject_user_id" IS NOT NULL)
      OR ("report_targets"."kind" = 'question' AND "report_targets"."question_id" IS NOT NULL)
      OR ("report_targets"."kind" = 'response' AND "report_targets"."response_id" IS NOT NULL)
    )
  )
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_reason" CHECK ("reports"."reason_code" IN (
    'harassment', 'personal_information', 'spam', 'suspicious_url', 'inappropriate_recruitment', 'other'
  )),
	CONSTRAINT "reports_detail" CHECK (
    char_length("reports"."detail") <= 500
    OR ("reports"."detail" IS NULL AND "reports"."reason_code" <> 'other')
  ),
	CONSTRAINT "reports_other_detail" CHECK ("reports"."reason_code" <> 'other' OR coalesce(btrim("reports"."detail"), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "graduation_changes" ADD CONSTRAINT "graduation_changes_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graduation_changes" ADD CONSTRAINT "graduation_changes_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_role_changes" ADD CONSTRAINT "manager_role_changes_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_role_changes" ADD CONSTRAINT "manager_role_changes_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_requests" ADD CONSTRAINT "event_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_requests" ADD CONSTRAINT "event_requests_reviewer_id_community_users_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_requests" ADD CONSTRAINT "event_requests_revision_fk" FOREIGN KEY ("event_id","revision_id") REFERENCES "public"."event_revisions"("event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_revisions" ADD CONSTRAINT "event_revisions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_author_id_community_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_public_revision_fk" FOREIGN KEY ("id","public_revision_id") REFERENCES "public"."event_revisions"("event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_requests" ADD CONSTRAINT "notice_requests_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_requests" ADD CONSTRAINT "notice_requests_reviewer_id_community_users_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_requests" ADD CONSTRAINT "notice_requests_revision_fk" FOREIGN KEY ("notice_id","revision_id") REFERENCES "public"."notice_revisions"("notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_revisions" ADD CONSTRAINT "notice_revisions_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_author_id_community_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_public_revision_fk" FOREIGN KEY ("id","public_revision_id") REFERENCES "public"."notice_revisions"("notice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_questions" ADD CONSTRAINT "qa_questions_author_id_community_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_questions" ADD CONSTRAINT "qa_questions_category_id_qa_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."qa_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_responses" ADD CONSTRAINT "qa_responses_question_id_qa_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."qa_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_responses" ADD CONSTRAINT "qa_responses_author_id_community_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_responses" ADD CONSTRAINT "qa_responses_parent_question_fk" FOREIGN KEY ("parent_response_id","question_id") REFERENCES "public"."qa_responses"("id","question_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_snapshots" ADD CONSTRAINT "evidence_snapshots_target_id_report_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."report_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_community_users_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_qa_question_id_qa_questions_id_fk" FOREIGN KEY ("qa_question_id") REFERENCES "public"."qa_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_qa_response_id_qa_responses_id_fk" FOREIGN KEY ("qa_response_id") REFERENCES "public"."qa_responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notice_request_id_notice_requests_id_fk" FOREIGN KEY ("notice_request_id") REFERENCES "public"."notice_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_request_id_event_requests_id_fk" FOREIGN KEY ("event_request_id") REFERENCES "public"."event_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_review_id_profile_reviews_id_fk" FOREIGN KEY ("profile_review_id") REFERENCES "public"."profile_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_user_id_community_users_user_id_fk" FOREIGN KEY ("profile_user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_actions" ADD CONSTRAINT "report_actions_case_id_report_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."report_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_actions" ADD CONSTRAINT "report_actions_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_case_evidence" ADD CONSTRAINT "report_case_evidence_case_id_report_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."report_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_case_evidence" ADD CONSTRAINT "report_case_evidence_evidence_id_evidence_snapshots_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_target_id_report_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."report_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cases" ADD CONSTRAINT "report_cases_assignee_id_community_users_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_targets" ADD CONSTRAINT "report_targets_subject_user_id_community_users_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_targets" ADD CONSTRAINT "report_targets_question_id_qa_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."qa_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_targets" ADD CONSTRAINT "report_targets_response_id_qa_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."qa_responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_report_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."report_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_community_users_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graduation_changes_user_date" ON "graduation_changes" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "manager_role_changes_user_date" ON "manager_role_changes" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_requests_one_pending" ON "event_requests" USING btree ("event_id") WHERE "event_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "event_requests_status_date" ON "event_requests" USING btree ("status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "event_requests_event_date" ON "event_requests" USING btree ("event_id","submitted_at","id");--> statement-breakpoint
CREATE INDEX "event_revisions_start_date" ON "event_revisions" USING btree ("starts_at","id");--> statement-breakpoint
CREATE INDEX "events_author_date" ON "events" USING btree ("author_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "events_public_date" ON "events" USING btree ("first_published_at","id") WHERE "events"."public_revision_id" IS NOT NULL AND "events"."forced_hidden_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notice_requests_one_pending" ON "notice_requests" USING btree ("notice_id") WHERE "notice_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notice_requests_status_date" ON "notice_requests" USING btree ("status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "notice_requests_notice_date" ON "notice_requests" USING btree ("notice_id","submitted_at","id");--> statement-breakpoint
CREATE INDEX "notices_author_date" ON "notices" USING btree ("author_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "notices_public_date" ON "notices" USING btree ("first_published_at","id") WHERE "notices"."public_revision_id" IS NOT NULL AND "notices"."deleted_at" IS NULL AND "notices"."forced_hidden_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qa_questions_category_date" ON "qa_questions" USING btree ("category_id","created_at","id");--> statement-breakpoint
CREATE INDEX "qa_questions_author_date" ON "qa_questions" USING btree ("author_id","created_at","id");--> statement-breakpoint
CREATE INDEX "qa_questions_public_date" ON "qa_questions" USING btree ("created_at","id") WHERE "qa_questions"."deleted_at" IS NULL AND "qa_questions"."forced_hidden_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qa_responses_question_date" ON "qa_responses" USING btree ("question_id","created_at","id");--> statement-breakpoint
CREATE INDEX "qa_responses_parent" ON "qa_responses" USING btree ("parent_response_id","question_id");--> statement-breakpoint
CREATE INDEX "qa_responses_author_date" ON "qa_responses" USING btree ("author_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_date" ON "audit_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_target_date" ON "audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_snapshots_target_date" ON "evidence_snapshots" USING btree ("target_id","captured_at","id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_date" ON "notifications" USING btree ("recipient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_recipient_unread" ON "notifications" USING btree ("recipient_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "report_actions_case_date" ON "report_actions" USING btree ("case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "report_case_evidence_snapshot" ON "report_case_evidence" USING btree ("evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_cases_one_active" ON "report_cases" USING btree ("target_id") WHERE "report_cases"."status" IN ('unhandled', 'in_progress');--> statement-breakpoint
CREATE INDEX "report_cases_target" ON "report_cases" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "report_cases_assignee_status" ON "report_cases" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "reports_case_date" ON "reports" USING btree ("case_id","created_at","id");--> statement-breakpoint
CREATE INDEX "reports_reporter" ON "reports" USING btree ("reporter_id");