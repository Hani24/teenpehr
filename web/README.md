# web/

The Next.js app for Tabayyun: reader site (`app/[locale]`, invite-only), admin (`app/admin`), worker API
(`app/api/worker`, bearer token, outside the login wall). See the root [README](../README.md),
[docs/PLAN.md](../docs/PLAN.md) and [docs/API.md](../docs/API.md).

```bash
npm run dev          # http://localhost:3000/en · /ur · /admin
npm run typecheck && npm run lint && npm run build
npm run db:push -- --force && npm run db:seed   # dev schema (db:prepare first, then drizzle-kit push) + seed data (db/seed/*.json)
npm run sources:apply -- --dry-run   # then without --dry-run: apply the audited source list (D11) to an existing database
npm run db:backfill  # after a schema push on an existing database: one-off data fixes (idempotent, see db/backfill.ts)
npm run db:migrate   # a new production database: applies db/migrations/ in order
npm run user:invite -- --email you@example.com --role owner   # print a one-time invite link (first owner; --kind reset for a new password)
npm run fonts        # re-download and subset every self-hosted font (bash scripts/fonts.sh nastaliq naskh vazir for some)
```

## Database

`db/schema.ts` is the schema. Two ways to apply it, which end in the same schema (checked column by column,
index by index):

- **Push** (development, and the laptop database, which was built this way): `npm run db:push -- --force`.
  It runs `db:prepare` first, which executes `db/migrations/0000_extensions.sql` (the `pg_trgm` extension and
  `immutable_array_join()`, which the generated search columns need), then `drizzle-kit push`. Follow it with
  `npm run db:backfill`, which makes the data changes the migrations carry (the Wazeh and Tabayyun renames,
  the default palette).
  Push re-applies the `'{}'::text[]` array defaults every time; that is a drizzle-kit quirk and changes nothing.
- **Migrations** (a new production database): `npm run db:migrate` applies `db/migrations/` in order:
  `0000_extensions` (custom), `0001_baseline` (generated from the schema), `0002_wazeh_tabayyun` and
  `0003_default_palette` (data), `0004_story_images` and `0005_feedback_jobs_manual` (D7–D13). Then `npm run db:seed`.
  The seed switches a source on only when its recorded audit check is `ok` (D11); on an existing database use
  `npm run sources:apply` instead, which also follows moved feeds (`previous_urls`) and turns failing rows off.
  After a schema change, `npm run db:generate` adds the next one. Do not run migrations on a pushed
  database: its tables already exist; keep it on push.

Nothing the worker stores is deleted (docs/PLAN.md, D5). Search: `stories.search_en` (English, stemmed,
weighted title > keywords and summary > why and contested), `stories.search_ur` and `items.search` (`simple`) are
generated `tsvector` columns with GIN indexes; story titles and entity names also have trigram indexes. Pages load
stories and items without those columns and without `raw` (see `lib/queries.ts`).

Published data is cached across requests (`lib/queries.ts`: `unstable_cache` with the tags `editions` and
`settings`, Dates revived on the way out). Publishing expires `editions` (`lib/admin/publish.ts`), and every admin
action that changes what readers see expires both; a change made outside the app (psql, a backfill) shows within
ten minutes, or at once after `systemctl --user restart teenpehr-web`.

## Accounts

`lib/auth/` is the sign-in core (decision D2): scrypt passwords, database sessions in the `tb_session` cookie,
the sign-in rate limit, invite and reset links, private feed tokens and reader preferences. Server code imports
`@/lib/auth`; `web/proxy.ts` can import `@/lib/auth/session-store` (no request APIs); client components can import
`@/lib/auth/roles` and `@/lib/auth/prefs`. There is no sign-up: the first owner comes from `npm run user:invite`,
everyone else from an owner's invite.

- **The wall.** `proxy.ts` sends every request without a valid session to `/{locale}/login?next=…` (a page) or
  answers 401 (anything else); `lib/auth/paths.ts` lists what stays outside: the worker API, the sign-in, invite
  and reset pages and their form handlers, the feeds (which check their own `?token=`), icons, the manifest,
  `robots.txt` and `sw.js`. Behind it, the locale layout and every reader page check the session again
  (`requireUser`, `gateReader`), and admin pages and actions check the role (`requireAdmin`, `requireOwner`).
  Readers get a plain 403 on `/admin`; editors on `/admin/users` and `/admin/export`. Every page answers
  `Cache-Control: private, no-store`.
- **Pages.** `/{locale}/login`; `/{locale}/invite/{token}` and `/{locale}/reset/{token}` (the links owners make on
  `/admin/users`, 7 days and 24 hours); `/{locale}/account` (name, password, private feed link, sign out
  everywhere).
- **Revocation.** Sign out everywhere, a password change, a used reset link, an owner's sign-out and disabling
  an account end every session and also turn off the account's feed token and open reset link
  (`destroyAllSessions`). Demoting or disabling an owner retires the invite and reset links they made, and a
  link whose maker is no longer an active owner is refused when used.
- **Admin messages.** `?ok=` / `?error=` on admin pages are shown only when signed for the viewer's session
  (`&fs=`, `lib/admin/flash.ts`), so a crafted link cannot put text in the status banner.
- **Form handlers** (POST, form-encoded, same-origin only, answering 303 with `?ok=` or `?error=` codes):
  `/api/auth/login`, `/api/auth/logout` (`everywhere=1` for every device), `/api/auth/accept` (invite or reset),
  `/api/auth/password`, `/api/auth/profile`, `/api/auth/feed-token` (`rotate` or `revoke`).
- **Sign-in limits.** Five failures per email from one address, twenty per email in all and twenty per address,
  in fifteen minutes (`lib/auth/rate-limit.ts`); a success or an owner's reset link clears the email's count.
  Each attempt is counted, under a lock, before its password is checked, so a parallel burst gets no more tries.
  The address is the last `X-Forwarded-For` hop, so run the app behind one reverse proxy (or none).
- **Sessions** last 30 days from the last visit and are Secure cookies in production: serve over https (or
  `http://localhost`).

## Saving and offline (D3)

- `/{locale}/saved`: the reader's shelf of stories and editions (`lib/saved.ts`, `lib/saved-actions.ts`).
- `/{locale}/{date}/{slot}/print`: the edition as an A4 sheet to save as PDF (`app/print.css`).
- `/{locale}/{date}/{slot}/download` and `/{locale}/saved/download`: one self-contained HTML file each
  (`lib/offline-html.ts`): inline styles, no scripts, no external URLs but the source links.
- `public/sw.js`, registered by `components/sw-register.tsx` in production builds: keeps the latest editions,
  their stories and the shelf (the list comes from `/api/offline/manifest`) and every reader page visited;
  network-first, falling back to the kept copy offline, on a slow network or on a 5xx. Never keeps sign-in,
  account, search, admin, API or download addresses. Sign-out (a load of `/{locale}/login?ok=signed_out`, where
  the logout lands) and another account signing in on the browser clear every kept copy. Bump `VERSION` in
  `sw.js` when its caching rules change.

## Smoke test (throwaway database only)

`scripts/smoke.py` drives the worker API end to end: it creates a run, posts items and a post,
upserts an edition, **publishes it**, then fetches the reader pages in both locales (signed in as
`SMOKE_EMAIL`/`SMOKE_PASSWORD`, an account on the smoke database; without them it checks that each page
sends a signed-out visitor to sign in). Everything it
writes is fabricated (example.org sources, an invented post), and published editions are immutable,
so it refuses to write unless the server reports a database whose name ends in `_smoke`. Run the
app on a throwaway database for it, never on the one the worker publishes to:

```bash
docker compose exec db createdb -U teenpehr teenpehr_smoke        # once, from the repo root
export DATABASE_URL=postgres://teenpehr:teenpehr@127.0.0.1:5432/teenpehr_smoke
npm run db:push -- --force && npm run db:seed
EDITION_SNAPSHOT_DIR=/tmp/teenpehr-smoke-snapshots npx next dev -p 3100
python3 scripts/smoke.py http://localhost:3100                     # in another shell
```

It reads `WORKER_TOKEN` from the environment, else from `.env.local`. Its editions are dated in
the year 2000, so they never collide with real slots or snapshot files.

## Notes

- **Fonts.** Inter and Newsreader go through `next/font` (Inter preloaded on every page). The Urdu
  faces are declared in `lib/fonts.ts` and served from `public/fonts/`, so the locale layout can
  preload Nastaliq on Urdu pages only. After `npm run fonts`, bump `FONT_VERSION` in `lib/fonts.ts`
  (`/fonts/` is cached as immutable).
- **Palettes and Wazeh** (D4) are listed once in `lib/auth/prefs.ts` and `lib/view.ts`; a palette is that
  entry, a token block and a high-contrast block in `app/globals.css` and `themes.<id>`/`themes.<id>Hint` in
  `messages/*.json`. Run `node scripts/contrast-check.mjs` after changing colours (AA for every palette, AAA for
  high contrast). The admin's default palette and mode, Urdu digits, disclosure text and the groups hidden in
  Wazeh come from the settings and groups tables; a reader's own choices override them.
- **Publishing and review** (docs/PLAN.md D14). `settings.publish_policy` is `publish` by default: the worker's
  publish call puts an edition out at once, QA-flagged stories included; `auto` holds one with a flagged story,
  `hold` holds every edition (held editions are published from their admin page). Each AI-written story then shows
  readers whether an editor has reviewed it (`components/review-badge.tsx`, `lib/review-state.ts`, and
  `lib/review-text.ts` for the feeds, the print sheet and the HTML download): "Not reviewed yet", "Check raised a
  question" (with the check's note on the story page) or "Reviewed by <name>". Editors work through
  `/admin/review` (`lib/admin/review.ts`, `lib/admin/review-actions.ts`): mark reviewed, add a correction, withdraw
  with a reason; owners can undo a review or a withdrawal. A withdrawn story (`stories.withdrawn_at`) is left out of
  every reader list (`storyVisibleSql` in `lib/desk.ts`, the relational loads in `lib/queries.ts`, search, the X
  board, the Saved shelf, `/media`), and its address shows only that it was withdrawn, when and why. The offline
  manifest gives each kept page a review token (`rev`, matched against the page's `data-tb-rev` by `public/sw.js`)
  and a `drop` list of withdrawn stories, so kept copies follow. The site-wide disclosure (settings
  `disclosure_en`/`_ur`) makes no claim about any one story; each story carries its own.
- **Messages.** `messages/en.json` and `ur.json` have the same keys; `global.d.ts` types `t()` against
  `en.json`, so `npm run typecheck` fails on a key that does not exist.
- **Snapshots.** Published editions are also written as JSON to `EDITION_SNAPSHOT_DIR` (default
  `~/.local/share/teenpehr/snapshots`), never inside `.next/`, which every build wipes. Each story carries its
  image's metadata (credit, alt, size, `graphic`, variant files), not the image itself.
- **Publisher images** (docs/PLAN.md D6). The worker uploads each story's image through `POST /api/worker/images`
  as re-encoded WebP variants; the files go to `MEDIA_DIR` as `<sha256>-<w>.webp` (absolute; default
  `~/.local/share/teenpehr/media`; the systemd unit sets the same, never inside `.next/`) and the row to `images`.
  `GET /media/<file>` serves them to signed-in readers only (`app/media/[file]/route.ts`, walled by the proxy too),
  privately cached for a year; a reader gets only files a published, not-hidden story shows (editors get any). Back the directory up with the database: a published story's image lives only there.
  Names, limits and the `<img>` attributes are in `lib/media.ts`; files in `lib/media-store.ts` (server only).
  A reader's `images` preference (`auto|on|off`, `lib/auth/prefs.ts`) is on `<html data-images>`, with
  `data-save-data="on"` when the device asks to save data (auto then shows none).
