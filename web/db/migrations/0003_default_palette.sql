-- Data: decision D4. Settings.default_theme now names a palette and is honoured; before, the boot
-- script always followed the device, so a stored value never took effect. A default_theme saved
-- before the Settings screen had a default mode (there is no default_mode row yet) therefore becomes
-- "system", which keeps what readers saw, and the old large-type theme (buzurg, renamed wazeh by 0002)
-- becomes the Wazeh mode on it. Once Settings is saved, both rows exist and nothing here runs again.
-- db/backfill.ts makes the same change on databases built with db:push.
WITH "old" AS (
  SELECT "value" FROM "settings"
  WHERE "key" = 'default_theme' AND NOT EXISTS (SELECT 1 FROM "settings" WHERE "key" = 'default_mode')
), "mode" AS (
  INSERT INTO "settings" ("key", "value")
  SELECT 'default_mode', CASE WHEN "value" IN ('"buzurg"'::jsonb, '"wazeh"'::jsonb) THEN '"wazeh"'::jsonb ELSE '"standard"'::jsonb END FROM "old"
  RETURNING 1
)
UPDATE "settings" SET "value" = '"system"'::jsonb WHERE "key" = 'default_theme' AND EXISTS (SELECT 1 FROM "old");
