ALTER TABLE "stories" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "reviewed_by" integer;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "withdrawn_by" integer;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "withdraw_note_en" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "withdraw_note_ur" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_unreviewed" ON "stories" USING btree ("edition_id") WHERE "stories"."reviewed_at" is null and "stories"."withdrawn_at" is null;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_reviewed_by" CHECK ("stories"."reviewed_by" is null or "stories"."reviewed_at" is not null);--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_withdrawn_by" CHECK ("stories"."withdrawn_by" is null or "stories"."withdrawn_at" is not null);--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_withdraw_note" CHECK ("stories"."withdrawn_at" is null or btrim("stories"."withdraw_note_en") <> '' or btrim("stories"."withdraw_note_ur") <> '');--> statement-breakpoint
-- Data: decision D14 (docs/PLAN.md). Editions publish without waiting for an editor: the shipped publish policy
-- "auto" (hold an edition with a flagged story) becomes "publish"; "hold", an explicit choice, stays. The site-wide
-- disclosure no longer claims that every story was written by AI and reviewed by an editor (each story now says
-- so itself), so the shipped text is replaced, only where it is still the shipped text (an edited one stays).
-- db/backfill.ts makes the same change on databases built with db:push.
UPDATE "settings" SET "value" = '"publish"'::jsonb WHERE "key" = 'publish_policy' AND "value" = '"auto"'::jsonb;--> statement-breakpoint
UPDATE "settings" SET "value" = to_jsonb('Stories are written by AI from the listed sources, except those marked as manual entries, which an editor wrote. Each AI-written story shows whether an editor has reviewed it yet. Every claim links to its source.'::text) WHERE "key" = 'disclosure_en' AND "value" = to_jsonb('Written by AI from the listed sources and reviewed by a human editor. Every claim links to its source.'::text);--> statement-breakpoint
UPDATE "settings" SET "value" = to_jsonb('خبریں درج ذرائع سے مصنوعی ذہانت لکھتی ہے، سوائے ان کے جن پر دستی اندراج لکھا ہو، جو ایڈیٹر نے لکھی ہیں۔ مصنوعی ذہانت کی لکھی ہر خبر پر درج ہے کہ کسی ایڈیٹر نے اس کا جائزہ لیا ہے یا ابھی نہیں۔ ہر بات کا حوالہ موجود ہے۔'::text) WHERE "key" = 'disclosure_ur' AND "value" = to_jsonb('یہ خبر درج ذیل ذرائع سے مصنوعی ذہانت نے تیار کی اور ایک انسانی ایڈیٹر نے اس کا جائزہ لیا۔ ہر بات کا حوالہ موجود ہے۔'::text);
