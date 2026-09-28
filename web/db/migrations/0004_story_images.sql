ALTER TYPE "public"."run_output_stage" ADD VALUE 'image';--> statement-breakpoint
CREATE TABLE "images" (
	"id" serial PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"source_url" text NOT NULL,
	"item_id" integer,
	"post_id" integer,
	"source_id" integer,
	"credit" text NOT NULL,
	"alt" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"color" text NOT NULL,
	"graphic" boolean DEFAULT true NOT NULL,
	"variants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "images_one_owner" CHECK (num_nonnulls("images"."item_id", "images"."post_id") = 1),
	CONSTRAINT "images_sha256_hex" CHECK ("images"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "images_color_hex" CHECK ("images"."color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "images_size" CHECK ("images"."width" > 0 and "images"."height" > 0),
	CONSTRAINT "images_credit" CHECK ("images"."credit" <> ''),
	CONSTRAINT "images_variants" CHECK (case when jsonb_typeof("images"."variants") = 'array' then jsonb_array_length("images"."variants") between 1 and 2 else false end)
);
--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "image_id" integer;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "image_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "image_hidden_by" integer;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "images_sha256_item" ON "images" USING btree ("sha256","item_id") WHERE "images"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "images_sha256_post" ON "images" USING btree ("sha256","post_id") WHERE "images"."post_id" is not null;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_image_hidden_by_users_id_fk" FOREIGN KEY ("image_hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_image" ON "stories" USING btree ("image_id") WHERE "stories"."image_id" is not null;