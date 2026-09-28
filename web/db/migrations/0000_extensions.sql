-- Runs before the schema: the trigram indexes need pg_trgm, and the generated search columns need an
-- immutable array_to_string (the built-in one is only STABLE, which a generated column refuses).
-- `npm run db:prepare` (run by db:push) executes this same file, so push-built databases match.
-- Idempotent: safe on a database that already has both.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION immutable_array_join(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;
