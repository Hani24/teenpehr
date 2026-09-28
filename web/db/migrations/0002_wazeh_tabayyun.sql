-- Data: decisions D1 (the app is Tabayyun, تبیُّن) and D4 (the large-type reading mode "buzurg" is now
-- "wazeh"). db/backfill.ts makes the same changes on databases built with db:push. Only the shipped
-- name is replaced, so a site name an owner typed in Settings stays.
UPDATE "groups"
  SET "hidden_in_themes" = array_remove("hidden_in_themes", 'buzurg')
    || CASE WHEN 'wazeh' = ANY("hidden_in_themes") THEN '{}'::text[] ELSE '{wazeh}'::text[] END
  WHERE 'buzurg' = ANY("hidden_in_themes");
--> statement-breakpoint
UPDATE "settings" SET "value" = '"wazeh"'::jsonb WHERE "key" = 'default_theme' AND "value" = '"buzurg"'::jsonb;
--> statement-breakpoint
UPDATE "settings" SET "value" = '"Tabayyun"'::jsonb WHERE "key" = 'site_name_en' AND lower(btrim("value" #>> '{}')) = 'teen pehr';
--> statement-breakpoint
UPDATE "settings" SET "value" = '"تبیُّن"'::jsonb WHERE "key" = 'site_name_ur' AND btrim("value" #>> '{}') = 'تین پہر';
