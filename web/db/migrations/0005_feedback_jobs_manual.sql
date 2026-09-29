-- Decisions D8-D12 (docs/PLAN.md): relevance feedback and mistake reports (story_feedback,
-- story_reports), worker jobs (worker_jobs) and full-article Urdu translations (article_translations),
-- manual stories and the Editor's desk (stories.origin, created_by, created_by_name, language_filled,
-- placement, desk_at; qa_status 'manual'), proposed public X Lists (x_list_proposals), an admin audit log,
-- and the source kinds manual, sitemap and gdelt. Purely additive: existing stories become origin 'ai'.
-- The enum values added here are not used by any statement in this file (Postgres refuses a value added
-- in the same transaction).
CREATE TYPE "public"."manual_placement" AS ENUM('edition', 'desk');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."story_origin" AS ENUM('ai', 'manual');--> statement-breakpoint
CREATE TYPE "public"."translation_status" AS ENUM('queued', 'running', 'done', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."worker_job_kind" AS ENUM('translate_article', 'fill_language', 'story_image');--> statement-breakpoint
CREATE TYPE "public"."worker_job_status" AS ENUM('queued', 'running', 'done', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."x_list_proposal_status" AS ENUM('proposed', 'added', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."qa_status" ADD VALUE 'manual';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'manual';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'sitemap';--> statement-breakpoint
ALTER TYPE "public"."source_kind" ADD VALUE 'gdelt';--> statement-breakpoint
CREATE TABLE "article_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"lang" text DEFAULT 'ur' NOT NULL,
	"status" "translation_status" DEFAULT 'queued' NOT NULL,
	"title" text,
	"body" text,
	"source_text_hash" text,
	"source_words" integer,
	"model" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"check_ok" boolean,
	"check_note" text,
	"job_id" integer,
	"requested_by" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"blocked_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_translations_lang" CHECK ("article_translations"."lang" = 'ur')
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_feedback" (
	"user_id" integer NOT NULL,
	"story_id" integer NOT NULL,
	"value" smallint NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_feedback_user_id_story_id_pk" PRIMARY KEY("user_id","story_id"),
	CONSTRAINT "story_feedback_value" CHECK ("story_feedback"."value" in (-1, 1)),
	CONSTRAINT "story_feedback_reasons" CHECK ("story_feedback"."reasons" <@ array['topic', 'outlet', 'too_much', 'not_for_me']::text[] and ("story_feedback"."value" = -1 or cardinality("story_feedback"."reasons") = 0))
);
--> statement-breakpoint
CREATE TABLE "story_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"story_id" integer NOT NULL,
	"text" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"resolved_by" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_reports_text" CHECK (char_length("story_reports"."text") between 1 and 2000),
	CONSTRAINT "story_reports_locale" CHECK ("story_reports"."locale" in ('en', 'ur'))
);
--> statement-breakpoint
CREATE TABLE "worker_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "worker_job_kind" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" "worker_job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"requested_by" integer,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "worker_jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "worker_jobs_attempts" CHECK ("worker_jobs"."attempts" >= 0 and "worker_jobs"."max_attempts" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "x_list_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"list_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"owner_handle" text DEFAULT '' NOT NULL,
	"url" text,
	"member_count" integer,
	"sample_handles" text[] DEFAULT '{}'::text[] NOT NULL,
	"posts_seen" integer,
	"newest_post_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"status" "x_list_proposal_status" DEFAULT 'proposed' NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x_list_proposals_list_id" CHECK ("x_list_proposals"."list_id" ~ '^[0-9]{1,25}$')
);
--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "origin" "story_origin" DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "created_by_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "language_filled" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "placement" "manual_placement";--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "desk_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_job_id_worker_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."worker_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_translations" ADD CONSTRAINT "article_translations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_feedback" ADD CONSTRAINT "story_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_feedback" ADD CONSTRAINT "story_feedback_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_reports" ADD CONSTRAINT "story_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_jobs" ADD CONSTRAINT "worker_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_list_proposals" ADD CONSTRAINT "x_list_proposals_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_list_proposals" ADD CONSTRAINT "x_list_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_translations_item_lang" ON "article_translations" USING btree ("item_id","lang");--> statement-breakpoint
CREATE INDEX "article_translations_status" ON "article_translations" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "audit_log_at" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target" ON "audit_log" USING btree ("target");--> statement-breakpoint
CREATE INDEX "story_feedback_story" ON "story_feedback" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "story_feedback_updated" ON "story_feedback" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "story_reports_status" ON "story_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "story_reports_story" ON "story_reports" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "worker_jobs_claim" ON "worker_jobs" USING btree ("kind","priority","id") WHERE "worker_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "worker_jobs_requested" ON "worker_jobs" USING btree ("requested_by","kind","created_at") WHERE "worker_jobs"."requested_by" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "x_list_proposals_group_list" ON "x_list_proposals" USING btree ("group_id","list_id");--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_handle_posted" ON "posts" USING btree ("handle_id","posted_at");--> statement-breakpoint
CREATE INDEX "stories_desk" ON "stories" USING btree ("desk_at") WHERE "stories"."desk_at" is not null;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_manual_placement" CHECK (("stories"."origin" = 'manual') = ("stories"."placement" is not null));--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_desk_at" CHECK ("stories"."desk_at" is null or "stories"."placement" = 'desk');--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_language_filled" CHECK ("stories"."language_filled" is null or ("stories"."language_filled" in ('en', 'ur') and "stories"."origin" = 'manual'));