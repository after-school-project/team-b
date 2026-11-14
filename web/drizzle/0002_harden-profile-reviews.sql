CREATE INDEX "account_restrictions_user_date" ON "account_restrictions" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "profile_reviews_status_date" ON "profile_reviews" USING btree ("status","submitted_at","id");--> statement-breakpoint
CREATE INDEX "profile_reviews_user_date" ON "profile_reviews" USING btree ("user_id","submitted_at","id");--> statement-breakpoint
ALTER TABLE "profile_reviews" ADD CONSTRAINT "profile_reviews_decision_metadata" CHECK (
    ("profile_reviews"."status" = 'pending' AND "profile_reviews"."reviewer_id" IS NULL
      AND "profile_reviews"."decided_at" IS NULL AND "profile_reviews"."decision_reason" IS NULL)
    OR ("profile_reviews"."status" IN ('approved', 'rejected')
      AND "profile_reviews"."reviewer_id" IS NOT NULL AND "profile_reviews"."decided_at" IS NOT NULL)
  );--> statement-breakpoint
ALTER TABLE "profile_reviews" ADD CONSTRAINT "profile_reviews_rejection_reason" CHECK (
    "profile_reviews"."status" <> 'rejected' OR coalesce("profile_reviews"."decision_reason" ~ '[^[:space:]]', false)
  );