CREATE TYPE "public"."coverage" AS ENUM('broad', 'partisan', 'single-source');--> statement-breakpoint
CREATE TYPE "public"."edition_slot" AS ENUM('subh', 'dopahar', 'shaam');--> statement-breakpoint
CREATE TYPE "public"."edition_status" AS ENUM('draft', 'review', 'published');--> statement-breakpoint
CREATE TYPE "public"."entity_kind" AS ENUM('person', 'org', 'place', 'event', 'other');--> statement-breakpoint
CREATE TYPE "public"."glossary_kind" AS ENUM('person', 'place', 'org', 'other');--> statement-breakpoint
CREATE TYPE "public"."handle_role" AS ENUM('outlet', 'journalist', 'official', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."invite_kind" AS ENUM('invite', 'reset');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('x', 'bluesky', 'telegram', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."qa_status" AS ENUM('pending', 'verified', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('edition', 'x_collect');--> statement-breakpoint
CREATE TYPE "public"."run_output_stage" AS ENUM('curate', 'urdu', 'qa');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'ok', 'failed', 'empty', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('rss', 'html', 'gnews', 'youtube', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."source_route" AS ENUM('direct', 'germany');--> statement-breakpoint
CREATE TYPE "public"."story_tag" AS ENUM('must-read', 'worth-knowing', 'skim');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('reader', 'editor', 'owner');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"story_id" integer NOT NULL,
	"text_en" text NOT NULL,
	"text_ur" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edition_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"edition_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"lead_en" text DEFAULT '' NOT NULL,
	"lead_ur" text DEFAULT '' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editions" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"slot" "edition_slot" NOT NULL,
	"status" "edition_status" DEFAULT 'draft' NOT NULL,
	"run_id" integer,
	"published_at" timestamp with time zone,
	"snapshot_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "entity_kind" DEFAULT 'other' NOT NULL,
	"slug" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ur" text DEFAULT '' NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "entities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "glossary" (
	"id" serial PRIMARY KEY NOT NULL,
	"term_en" text NOT NULL,
	"term_ur" text NOT NULL,
	"kind" "glossary_kind" DEFAULT 'other' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "glossary_term_en_unique" UNIQUE("term_en")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ur" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"story_count" integer DEFAULT 7 NOT NULL,
	"hidden_in_themes" text[] DEFAULT '{}'::text[] NOT NULL,
	"x_list_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "handles" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"platform" "platform" DEFAULT 'x' NOT NULL,
	"handle" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"role" "handle_role" DEFAULT 'journalist' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_post_at" timestamp with time zone,
	"fallback_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"kind" "invite_kind" DEFAULT 'invite' NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'reader' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" integer,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_email_lower" CHECK ("invites"."email" = lower("invites"."email"))
);
--> statement-breakpoint
CREATE TABLE "item_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"title" text NOT NULL,
	"text_hash" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_sources" (
	"item_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_sources_item_id_source_id_pk" PRIMARY KEY("item_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"run_id" integer,
	"url" text NOT NULL,
	"url_canonical" text NOT NULL,
	"title" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone,
	"lang" text DEFAULT 'en' NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_url" text,
	"description" text,
	"word_count" integer,
	"lang_detected" text,
	"guid" text,
	"feed_updated_at" timestamp with time zone,
	"site_name" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"fetch" jsonb,
	"raw" jsonb,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, "title"), 'A') || setweight(to_tsvector('simple'::regconfig, "text"), 'D')) STORED,
	CONSTRAINT "items_url_canonical_unique" UNIQUE("url_canonical")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"ok" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempts_email_lower" CHECK ("login_attempts"."email" = lower("login_attempts"."email"))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle_id" integer,
	"platform" "platform" DEFAULT 'x' NOT NULL,
	"platform_id" text NOT NULL,
	"author_handle" text NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"url" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"is_repost" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lang" text,
	"metrics" jsonb,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"media" jsonb,
	"in_reply_to" text,
	"conversation_id" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_items" (
	"run_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	CONSTRAINT "run_items_run_id_item_id_group_id_pk" PRIMARY KEY("run_id","item_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "run_outputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"group_id" integer,
	"stage" "run_output_stage" NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"ok" boolean NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"error" text,
	"ms" integer DEFAULT 0 NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"route" "source_route" DEFAULT 'direct' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "run_kind" NOT NULL,
	"date" date,
	"slot" "edition_slot",
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"model" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "saved_editions" (
	"user_id" integer NOT NULL,
	"edition_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_editions_user_id_edition_id_pk" PRIMARY KEY("user_id","edition_id")
);
--> statement-breakpoint
CREATE TABLE "saved_stories" (
	"user_id" integer NOT NULL,
	"story_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "saved_stories_user_id_story_id_pk" PRIMARY KEY("user_id","story_id")
);
--> statement-breakpoint
CREATE TABLE "search_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"q" text NOT NULL,
	"q_norm" text NOT NULL,
	"locale" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"results" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" "source_kind" DEFAULT 'rss' NOT NULL,
	"url" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"perspective" text DEFAULT '' NOT NULL,
	"fetcher_tier" integer DEFAULT 0 NOT NULL,
	"route" "source_route" DEFAULT 'direct' NOT NULL,
	"max_items" integer DEFAULT 8 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" serial PRIMARY KEY NOT NULL,
	"edition_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"thread_id" integer,
	"order" integer DEFAULT 0 NOT NULL,
	"title_en" text NOT NULL,
	"title_ur" text DEFAULT '' NOT NULL,
	"summary_en" text NOT NULL,
	"summary_ur" text DEFAULT '' NOT NULL,
	"why_en" text DEFAULT '' NOT NULL,
	"why_ur" text DEFAULT '' NOT NULL,
	"tag" "story_tag" DEFAULT 'worth-knowing' NOT NULL,
	"coverage" "coverage",
	"contested_en" text DEFAULT '' NOT NULL,
	"contested_ur" text DEFAULT '' NOT NULL,
	"angles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qa_status" "qa_status" DEFAULT 'pending' NOT NULL,
	"qa_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"places" text[] DEFAULT '{}'::text[] NOT NULL,
	"event_type" text,
	"word_count" integer,
	"reading_time_sec" integer,
	"search_en" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, "title_en"), 'A') || setweight(to_tsvector('english'::regconfig, immutable_array_join("keywords")), 'B') || setweight(to_tsvector('english'::regconfig, "summary_en"), 'B') || setweight(to_tsvector('english'::regconfig, "why_en" || ' ' || "contested_en"), 'C')) STORED,
	"search_ur" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, "title_ur"), 'A') || setweight(to_tsvector('simple'::regconfig, "summary_ur"), 'B') || setweight(to_tsvector('simple'::regconfig, "why_ur" || ' ' || "contested_ur"), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "story_entities" (
	"story_id" integer NOT NULL,
	"entity_id" integer NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"salience" real,
	CONSTRAINT "story_entities_story_id_entity_id_pk" PRIMARY KEY("story_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "story_posts" (
	"story_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	CONSTRAINT "story_posts_story_id_post_id_pk" PRIMARY KEY("story_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "story_reads" (
	"user_id" integer NOT NULL,
	"story_id" integer NOT NULL,
	"first_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "story_reads_user_id_story_id_pk" PRIMARY KEY("user_id","story_id")
);
--> statement-breakpoint
CREATE TABLE "story_sources" (
	"story_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "story_sources_story_id_item_id_pk" PRIMARY KEY("story_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title_en" text NOT NULL,
	"title_ur" text DEFAULT '' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"keywords_en" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords_ur" text[] DEFAULT '{}'::text[] NOT NULL,
	"boost" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" "user_role" DEFAULT 'reader' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"feed_token_hash" text,
	"last_login_at" timestamp with time zone,
	"last_visit_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"invited_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_feed_token_hash_unique" UNIQUE("feed_token_hash"),
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_groups" ADD CONSTRAINT "edition_groups_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_groups" ADD CONSTRAINT "edition_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handles" ADD CONSTRAINT "handles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_sources" ADD CONSTRAINT "item_sources_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_sources" ADD CONSTRAINT "item_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_handle_id_handles_id_fk" FOREIGN KEY ("handle_id") REFERENCES "public"."handles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_items" ADD CONSTRAINT "run_items_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_outputs" ADD CONSTRAINT "run_outputs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_outputs" ADD CONSTRAINT "run_outputs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_editions" ADD CONSTRAINT "saved_editions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_editions" ADD CONSTRAINT "saved_editions_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_stories" ADD CONSTRAINT "saved_stories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_stories" ADD CONSTRAINT "saved_stories_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_log" ADD CONSTRAINT "search_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_entities" ADD CONSTRAINT "story_entities_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_entities" ADD CONSTRAINT "story_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_posts" ADD CONSTRAINT "story_posts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_posts" ADD CONSTRAINT "story_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_reads" ADD CONSTRAINT "story_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_reads" ADD CONSTRAINT "story_reads_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_sources" ADD CONSTRAINT "story_sources_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_sources" ADD CONSTRAINT "story_sources_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edition_groups_unique" ON "edition_groups" USING btree ("edition_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "editions_date_slot" ON "editions" USING btree ("date","slot");--> statement-breakpoint
CREATE INDEX "entities_name_en_trgm" ON "entities" USING gin ("name_en" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entities_name_ur_trgm" ON "entities" USING gin ("name_ur" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "handles_platform_handle" ON "handles" USING btree ("platform","handle");--> statement-breakpoint
CREATE INDEX "invites_email" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "item_revisions_item" ON "item_revisions" USING btree ("item_id","seen_at");--> statement-breakpoint
CREATE INDEX "item_sources_source_seen" ON "item_sources" USING btree ("source_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "items_source_seen" ON "items" USING btree ("source_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "items_published" ON "items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "items_search" ON "items" USING gin ("search");--> statement-breakpoint
CREATE INDEX "login_attempts_email_at" ON "login_attempts" USING btree ("email","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_platform_id" ON "posts" USING btree ("platform","platform_id");--> statement-breakpoint
CREATE INDEX "posts_posted" ON "posts" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "run_items_item" ON "run_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "run_outputs_run" ON "run_outputs" USING btree ("run_id","stage");--> statement-breakpoint
CREATE INDEX "saved_editions_edition" ON "saved_editions" USING btree ("edition_id");--> statement-breakpoint
CREATE INDEX "saved_stories_story" ON "saved_stories" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "search_log_created" ON "search_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_log_q_norm" ON "search_log" USING btree ("q_norm");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_group_url" ON "sources" USING btree ("group_id","url");--> statement-breakpoint
CREATE INDEX "stories_edition" ON "stories" USING btree ("edition_id","group_id","order");--> statement-breakpoint
CREATE INDEX "stories_thread" ON "stories" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "stories_search_en" ON "stories" USING gin ("search_en");--> statement-breakpoint
CREATE INDEX "stories_search_ur" ON "stories" USING gin ("search_ur");--> statement-breakpoint
CREATE INDEX "stories_title_en_trgm" ON "stories" USING gin ("title_en" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "stories_title_ur_trgm" ON "stories" USING gin ("title_ur" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "stories_topics" ON "stories" USING gin ("topics");--> statement-breakpoint
CREATE INDEX "stories_countries" ON "stories" USING gin ("countries");--> statement-breakpoint
CREATE INDEX "story_entities_entity" ON "story_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "story_reads_story" ON "story_reads" USING btree ("story_id");