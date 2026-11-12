CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"public_reason" text NOT NULL,
	"internal_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_restrictions_action" CHECK ("account_restrictions"."action" IN ('suspend', 'release')),
	CONSTRAINT "account_restrictions_reasons" CHECK (btrim("account_restrictions"."public_reason") <> '' AND btrim("account_restrictions"."internal_reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "community_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"base_role" text NOT NULL,
	"is_graduating" boolean DEFAULT false NOT NULL,
	"school_manager" boolean DEFAULT false NOT NULL,
	"app_manager" boolean DEFAULT false NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"profile_state" text DEFAULT 'public' NOT NULL,
	"eligibility_status" text DEFAULT 'pending' NOT NULL,
	"provisioning_status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "community_users_role" CHECK ("community_users"."base_role" IN ('student', 'alumni', 'staff')),
	CONSTRAINT "community_users_graduating_student" CHECK (NOT "community_users"."is_graduating" OR "community_users"."base_role" = 'student'),
	CONSTRAINT "community_users_school_manager_staff" CHECK (NOT "community_users"."school_manager" OR "community_users"."base_role" = 'staff'),
	CONSTRAINT "community_users_account_status" CHECK ("community_users"."account_status" IN ('active', 'suspended')),
	CONSTRAINT "community_users_profile_state" CHECK ("community_users"."profile_state" IN ('public', 'hidden')),
	CONSTRAINT "community_users_eligibility" CHECK ("community_users"."eligibility_status" IN ('pending', 'verified')),
	CONSTRAINT "community_users_provisioning" CHECK ("community_users"."provisioning_status" IN ('pending', 'ready')),
	CONSTRAINT "community_users_version" CHECK ("community_users"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "identity_records" (
	"user_id" text PRIMARY KEY NOT NULL,
	"private_real_name" text NOT NULL,
	"school_reference" text NOT NULL,
	"verification_note" text
);
--> statement-breakpoint
CREATE TABLE "profile_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "profile_reviews_status" CHECK ("profile_reviews"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "profile_reviews_version" CHECK ("profile_reviews"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"revision_no" integer NOT NULL,
	"display_name" text NOT NULL,
	"department" text,
	"entry_year" integer,
	"graduation_year" integer,
	"optional_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"field_visibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_revisions_user_revision_no" UNIQUE("user_id","revision_no"),
	CONSTRAINT "profile_revisions_user_id_id" UNIQUE("user_id","id"),
	CONSTRAINT "profile_revisions_revision_no" CHECK ("profile_revisions"."revision_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"search_opt_in" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "profiles_version" CHECK ("profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "qa_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "qa_categories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_restrictions" ADD CONSTRAINT "account_restrictions_actor_id_community_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_users" ADD CONSTRAINT "community_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_reviews" ADD CONSTRAINT "profile_reviews_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_reviews" ADD CONSTRAINT "profile_reviews_reviewer_id_community_users_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_reviews" ADD CONSTRAINT "profile_reviews_revision_owner_fk" FOREIGN KEY ("user_id","revision_id") REFERENCES "public"."profile_revisions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_revisions" ADD CONSTRAINT "profile_revisions_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_community_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."community_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_current_revision_owner_fk" FOREIGN KEY ("user_id","current_revision_id") REFERENCES "public"."profile_revisions"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_reviews_one_pending" ON "profile_reviews" USING btree ("user_id") WHERE "profile_reviews"."status" = 'pending';