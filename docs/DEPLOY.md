# Deploying Tabayyun on the Hetzner server (Coolify)

The web app runs as one Docker image on the Hetzner server (23.88.42.108), built and run by Coolify behind
its Traefik proxy with a Let's Encrypt certificate, at **https://tabayyun.code19.dev**, with a
Coolify-managed PostgreSQL 17 on the same server. The worker stays on the laptop and talks to the site over
HTTPS at `/api/worker/*` with the bearer token (docs/API.md); it never touches the database.

Who does what, marked on every step:

- **[Cloudflare]** and **[Coolify]**: in the dashboards, by the owner.
- **[SSH]**: on the server (`ssh hetzner`, the host the Germany proxy already uses), as root or as a user in
  the `docker` group (prefix `sudo` otherwise).
- **[Laptop]**: on the laptop, from the repository root unless it says `cd web` or `cd worker`.

No secret is written here. There are two: the database URL (Coolify makes it) and `WORKER_TOKEN` (you make it).

## What the image does

- `web/Dockerfile` builds in three stages on `node:22-trixie-slim` (Node 22, as on the laptop): `npm ci`,
  `next build`, then a runtime stage with only the standalone server, `public/`, `.next/static`,
  `db/migrations` and the migrator. **The build needs no database and no secret**: during `next build`,
  `web/db/index.ts` points the client at a socket that does not exist, whatever `DATABASE_URL` says, and no
  page queries at build time (each reads the session first, so every page that uses the database is dynamic;
  only robots.txt, the manifest and the icons are prerendered).
- It runs as the unprivileged `node` user (uid 1000) on port 3000, with `MEDIA_DIR=/data/media` and
  `EDITION_SNAPSHOT_DIR=/data/snapshots`. `/data` must be a persistent volume: a published story's image
  lives only there. `web/scripts/docker-entrypoint.sh` refuses to start when `/data` is not a mounted volume
  or is not writable, then runs the migrator, then `node server.js`.
- **Migrations at start** (`web/scripts/migrate.mjs`, drizzle-orm's migrator, under an advisory lock):
  - a database with a migration journal (`drizzle.__drizzle_migrations`): applies what is newer. Usually
    `migrate: up to date (last applied: …); nothing to do`;
  - an empty database: applies every migration in `web/db/migrations/`;
  - a database with tables but no journal (the laptop's, built with `npm run db:push`, restored from a dump):
    compares its structure with the snapshot drizzle-kit saved for each migration; on an exact match it
    records those migrations as applied **without running them** (`migrate: database built with db:push: its
    structure matches 0006_review_state; recording … as applied without running them`) and applies any
    later ones. On no match it changes nothing, prints the differences and exits 1: the container stops and,
    on a redeploy, the old one keeps serving.
  - `node scripts/migrate.mjs --dry-run` says what it would do and writes nothing.
- **Health check**: the image's `HEALTHCHECK` fetches `/robots.txt` from inside the container every 30 s
  (outside the login wall, no database; 90 s start period for migrations). Coolify uses it instead of its
  own check and waits for it before it replaces the running container.

## Order of the move

1. DNS record. 2. Postgres. 3. Freeze the laptop, dump, restore. 4. The application, first deploy.
5. Media and snapshots. 6. Check the site. 7. Point the worker at it and start the timers again.
8. Backups and uptime checks.

## 1. DNS [Cloudflare]

`code19.dev` → **DNS** → **Records** → **Add record**:

| Type | Name | IPv4 address | Proxy status | TTL |
| --- | --- | --- | --- | --- |
| A | `tabayyun` | `23.88.42.108` | **DNS only** (grey cloud), like `hub.code19.dev` | Auto |

If `hub.code19.dev` also has an AAAA record, add the same one for `tabayyun`. Keep it DNS only: Traefik gets
the certificate itself, and the sign-in rate limit counts attempts by the last `X-Forwarded-For` hop, which
must be the reader's own address as Traefik saw it (proxied, it would be a Cloudflare edge address shared by
many readers). Check: `dig +short tabayyun.code19.dev` answers `23.88.42.108`.

## 2. PostgreSQL 17 [Coolify]

1. **Projects** → **+ Add** a project `Tabayyun` (environment `production`), or use an existing one.
2. **+ New** → **Databases** → **PostgreSQL**; server: the Hetzner server; destination: the default
   (`coolify` network), the same one the application will use.
3. Before the first start, under **Configuration → General**:
   - name `tabayyun-db`;
   - PostgreSQL 17, as on the laptop: pick the 17 type when asked, and check that **Image** is a 17 tag
     (`postgres:17-alpine`);
   - **Username** `tabayyun`, **Password**: keep the generated one; leave **Initial Database** empty, so the
     database is Coolify's default `postgres` (what the live site uses: this container holds nothing else, and
     Coolify's internal URL and its Backups tab then point at it unchanged);
   - leave **Make it publicly available** off. Nothing outside the server needs port 5432.
4. **Start**. Copy the **internal URL** (`postgres://tabayyun:…@<container>:5432/postgres`, shown as
   "Postgres URL (internal)"): it is `DATABASE_URL` for step 4. It is a secret.

Do not deploy the application yet: the laptop's data goes into this database first (step 3), so the first
start of the app finds it and records the migrations instead of creating empty tables.

## 3. The laptop's database into it

**Freeze the laptop [Laptop]**, so nothing is published while the copy is made:

```bash
systemctl --user stop news-worker.timer x-collector.timer teenpehr-jobs.service
systemctl --user is-active news-worker.service x-collector.service   # wait until both say inactive
```

**Check the schema [Laptop].** If `web/db/schema.ts` changed since the laptop's last push, first
`cd web && npm run db:push -- --force && npm run db:backfill` (both idempotent). Then ask the migrator what
the server will do with this database; it only reads:

```bash
cd web && DATABASE_URL=postgres://teenpehr:teenpehr@127.0.0.1:5432/teenpehr node scripts/migrate.mjs --dry-run
```

It must say `structure matches 0006_review_state` (the newest migration at the time of writing). If it lists
differences instead, fix them on the laptop first; after a `schema.ts` change with no migration,
`npm run db:generate` and commit the new migration and its snapshot.

**Check for test accounts [Laptop].** Everything is copied (D5), accounts included:

```bash
docker exec teenpehr-db psql -U teenpehr -d teenpehr -c \
  "select id, email, role, status, created_at, last_login_at from users order by id"
```

Disable any test or smoke account (`example.org`, `smoke@…`, a throwaway address) on `/admin/users` before
the dump. The throwaway databases (`teenpehr_smoke` and the like) are separate and are not copied.

**Dump and copy [Laptop]:**

```bash
docker exec teenpehr-db pg_dump -U teenpehr -d teenpehr -Fc > ~/tabayyun-$(date +%F).dump
docker exec -i teenpehr-db pg_restore -l < ~/tabayyun-$(date +%F).dump | grep -c 'TABLE DATA'   # about 38
scp ~/tabayyun-$(date +%F).dump hetzner:
```

**Restore [SSH].** Coolify names the database container after the resource's UUID (in the Coolify URL of the
database):

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep postgres     # pick the tabayyun-db container
DB=<that container name>
docker exec -i "$DB" pg_restore -U tabayyun -d postgres --no-owner --no-privileges --single-transaction \
  --exit-on-error < ~/tabayyun-YYYY-MM-DD.dump
docker exec "$DB" psql -U tabayyun -d postgres -c "select count(*) as editions, max(published_at) as latest from editions"
rm ~/tabayyun-YYYY-MM-DD.dump                                  # it holds password hashes; the laptop keeps its copy
```

The database must be empty (`select count(*) from information_schema.tables where table_schema = 'public'` is 0).
If the app already started against it and created tables, start over with
`docker exec "$DB" psql -U tabayyun -d template1 -c 'drop database postgres with (force)' -c 'create database postgres'`.

## 4. The application [Coolify]

1. In the same project and environment: **+ New** → **Private Repository (with GitHub App)**. Pick the
   GitHub App (or create one under **Sources**, installed on `Hani24/teenpehr` only), repository
   `Hani24/teenpehr`, **Load Repository**, branch `main`. The App's webhook redeploys on every push to
   `main`. Alternative without an App: **Private Repository (with Deploy Key)**, with a read-only deploy key
   on the GitHub repository; then deploy by hand or add the webhook yourself.
2. **Build Pack** `Dockerfile`, **Base Directory** `/web`, **Dockerfile Location** `/Dockerfile`,
   **Ports Exposes** `3000`. Leave **Ports Mappings** empty: the container must be reachable only through
   Traefik (a published port would let a client choose its own `X-Forwarded-For`).
3. **Domains** `https://tabayyun.code19.dev`. Coolify asks Traefik for the Let's Encrypt certificate and
   redirects http to https.
4. **Environment Variables**. For every one, turn **Build Variable** off (the build needs none) and keep
   **Runtime Variable** on; lock the secrets so the UI hides them:

   | Name | Value | Secret |
   | --- | --- | --- |
   | `DATABASE_URL` | the internal URL from step 2 | yes |
   | `WORKER_TOKEN` | a new token: `openssl rand -hex 32` on the laptop; the same value goes into `worker/.env` (step 7). Not the laptop's old one. | yes |
   | `SITE_URL` | `https://tabayyun.code19.dev` (invite, reset and feed links, print and download pages) | no |
   | `NTFY_TOPIC` | optional: the same topic as `worker/.env`; the site posts "Edition published …" there | yes |

   Do not set `NODE_ENV`, `PORT`, `HOSTNAME`, `MEDIA_DIR` or `EDITION_SNAPSHOT_DIR`; the image sets them. No
   other variable is read by the site (`ADMIN_PASSWORD` is retired; there is no auth secret).
5. **Persistent Storage** → **+ Add** → **Volume Mount**: name `tabayyun-data`, no source path (a Docker
   volume), **Destination Path** `/data`. A new volume takes the image's ownership of `/data` (uid 1000).
6. **Healthcheck**: nothing to set; Coolify uses the image's own check.
7. **Deploy**. The log ends with:

   ```
   entrypoint: media in /data/media, edition snapshots in /data/snapshots
   migrate: database "postgres" (PostgreSQL 17.x), 7 migrations in /app/db/migrations
   migrate: database built with db:push: its structure matches 0006_review_state; recording 0000_extensions, … as applied without running them
   migrate: up to date (last applied: 0006_review_state); nothing to do
   migrate: structure matches 0006_review_state
   ✓ Ready in …
   ```

   Every later start says `up to date … nothing to do`, or names the new migrations it applied.

## 5. Media and snapshots [Laptop, SSH]

Image files are content-addressed and never change, so copying them while the site runs is safe.

```bash
# [SSH] the volume Coolify made for /data, and its directory on the host
docker volume ls --format '{{.Name}}' | grep tabayyun-data
VOL=$(docker volume inspect <that volume> --format '{{.Mountpoint}}')

# [Laptop]
rsync -a --info=stats1 ~/.local/share/teenpehr/media ~/.local/share/teenpehr/snapshots hetzner:tabayyun-import/

# [SSH]
cp -a ~/tabayyun-import/media/. "$VOL/media/" && cp -a ~/tabayyun-import/snapshots/. "$VOL/snapshots/"
chown -R 1000:1000 "$VOL" && rm -rf ~/tabayyun-import
ls "$VOL/media" | wc -l          # the same count as: ls ~/.local/share/teenpehr/media | wc -l on the laptop
```

Optional, cosmetic (the admin's edition page shows the path; nothing reads it back):

```bash
docker exec "$DB" psql -U tabayyun -d tabayyun -c \
  "update editions set snapshot_path = '/data/snapshots/' || regexp_replace(snapshot_path, '^.*/', '') where snapshot_path like '/home/%'"
```

## 6. Check the site

- https://tabayyun.code19.dev shows the sign-in page with a valid certificate. Sign in with your laptop
  account (same email and password): the latest edition, a story with its photo (served from `/media`), the
  admin. Everyone signs in again once on the new address; invite and reset links made on the laptop pointed
  at localhost, so make new ones on `/admin/users`.
- [Laptop] with the new token in the shell (`read -rs WORKER_TOKEN`, paste, Enter):

  ```bash
  curl -s -H "Authorization: Bearer $WORKER_TOKEN" https://tabayyun.code19.dev/api/worker/health   # {"ok":true,…,"database":"postgres"}
  curl -s -o /dev/null -w '%{http_code}\n' https://tabayyun.code19.dev/api/worker/health         # 401
  ```

## 7. Point the worker at the site [Laptop]

1. In `worker/.env`: `SITE_URL=https://tabayyun.code19.dev` and `WORKER_TOKEN=` the token from step 4.
2. Claude: if `CLAUDE_CODE_OAUTH_TOKEN` is not set yet, `claude setup-token` and put the token in
   `worker/.env` (steadier for timers than the interactive login; infra/README.md step 3).
3. Retire the laptop's web app. The worker units have `Wants=teenpehr-web.service`, which starts it on every
   run while its unit file is installed; with the file gone that line does nothing:

   ```bash
   systemctl --user disable --now teenpehr-web.service
   rm ~/.config/systemd/user/teenpehr-web.service && systemctl --user daemon-reload   # infra/systemd/ keeps the original
   ```

4. Check and start again:

   ```bash
   cd worker && uv run teenpehr health && cd ..     # the site answers with this token, and "logged_in": true
   systemctl --user enable --now germany-proxy.service x-collector.timer news-worker.timer teenpehr-jobs.service
   systemctl --user restart teenpehr-jobs.service  # re-reads worker/.env if it was already running
   systemctl --user list-timers
   ```

   The next slot publishes to the live site (`journalctl --user -u news-worker -f`). Job results the site
   could not take while frozen wait in `worker/out/state/job-outbox/` and go out before the next claim.

The laptop's Postgres is no longer used by anything live. Keep it for development (and the last dump as a
backup), or stop it with `docker compose stop db`.

## Deploying changes

- Push to `main`; Coolify builds and replaces the container once the new one is healthy. A failed build,
  a failed migration or a missing volume leaves the running one in place (Deployments → the log says why).
- Schema changes: edit `web/db/schema.ts`, `npm run db:generate`, and commit the new `.sql` **and** its
  `meta/*_snapshot.json` and `_journal.json` (the migrator needs all three). The new image applies it at start.
  Keep migrations additive: during a deploy the old container briefly runs against the new schema.
- Before deploying a migration, **Backup Now** on the database (step 8).
- A change made outside the app (psql) shows within ten minutes, or at once after **Restart** in Coolify.
- Accounts: the first owner already exists (restored). `npm run user:invite` needs the source tree; for an
  emergency owner link run it on the laptop through a tunnel:
  `ssh -L 15432:<database container IP>:5432 hetzner` (IP from `docker inspect "$DB"`), then
  `DATABASE_URL=postgres://tabayyun:…@127.0.0.1:15432/tabayyun SITE_URL=https://tabayyun.code19.dev npx tsx --conditions=react-server scripts/invite.ts --email … --role owner` in `web/`.

## 8. Backups

**Nightly, off the server [Laptop]:** the database as a dump and `/data` as files, pulled over SSH. Save as
`~/bin/tabayyun-backup.sh` (fill in the two names from steps 3 and 5) and `chmod +x` it:

```sh
#!/bin/sh
# Nightly copy of the live site's database and /data volume to this laptop (docs/DEPLOY.md).
set -eu
DB=<tabayyun-db container name>
VOL=<volume mountpoint, /var/lib/docker/volumes/…/_data>
DEST=$HOME/backups/tabayyun
day=$(date +%F)
mkdir -p "$DEST/db" "$DEST/data"
ssh hetzner "docker exec $DB pg_dump -U tabayyun -d tabayyun -Fc" > "$DEST/db/$day.dump.part"
mv "$DEST/db/$day.dump.part" "$DEST/db/$day.dump"
rsync -a "hetzner:$VOL/" "$DEST/data/"                  # images are never deleted (D5), so no --delete
find "$DEST/db" -name '*.dump' -mtime +30 -delete        # 30 days of dumps
```

With a user timer (`~/.config/systemd/user/tabayyun-backup.service` and `.timer`):

```ini
# tabayyun-backup.service
[Unit]
Description=Tabayyun nightly backup from the server
OnFailure=news-alert@%n.service
[Service]
Type=oneshot
ExecStart=%h/bin/tabayyun-backup.sh

# tabayyun-backup.timer
[Timer]
OnCalendar=*-*-* 03:30
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl --user daemon-reload && systemctl --user enable --now tabayyun-backup.timer`; a failure alerts
through ntfy like the worker's units. `Persistent=true` runs a missed night when the laptop wakes.

**Also on the server [Coolify], optional:** the database → **Backups** → **+ Add** a schedule (`0 3 * * *`).
Local copies land in `/data/coolify/backups` on the same server, which does not survive losing it; to keep
them off the server, add an S3 storage (Hetzner Object Storage or Cloudflare R2) and turn on **S3** in the
schedule. Before a deploy with a migration, **Backup Now**.

**Test a restore monthly [Laptop]:**

```bash
f=$(ls -t ~/backups/tabayyun/db/*.dump | head -1)
docker exec teenpehr-db createdb -U teenpehr tabayyun_restorecheck
docker exec -i teenpehr-db pg_restore -U teenpehr -d tabayyun_restorecheck --no-owner --no-privileges --single-transaction --exit-on-error < "$f"
docker exec teenpehr-db psql -U teenpehr -d tabayyun_restorecheck -c "select max(published_at) from editions"
docker exec teenpehr-db dropdb -U teenpehr tabayyun_restorecheck
```

## Uptime

- An external monitor (UptimeRobot, Better Stack or an Uptime Kuma that is not on this server) every 5
  minutes on `https://tabayyun.code19.dev/robots.txt`, expecting 200: DNS, certificate, Traefik and the app.
  Most monitors also warn before the certificate expires (Traefik renews it).
- [Coolify] **Notifications**: a channel (Telegram, email, or **Webhook** to `https://ntfy.sh/<your topic>`,
  where it arrives as raw JSON) with **Deployment failed**, **Container status changes** and **Backup failed**.
- The database and the pipeline: every edition run and the X collector already alert through ntfy when the
  site's API fails (infra/README.md, Alerts). Nothing outside the login wall reports on the database, and a
  monitor must never get `WORKER_TOKEN` (it can publish).

## Rollback

- **A bad deploy:** the application → **Rollback** → pick the last good image (Coolify keeps the recent ones
  on the server), or `git revert` on `main` and push. Migrations are not undone: the older image runs against
  the newer schema, which is fine while migrations are additive.
- **A migration that damaged data:** stop the application; restore the backup taken before the deploy
  (drop and create the database as in step 3, then `pg_restore` as in step 3); roll the image back; start.
- **Back to the laptop:** freeze the worker (step 3); dump the server's database
  (`ssh hetzner "docker exec $DB pg_dump -U tabayyun -d tabayyun -Fc" > live.dump`), restore it into the
  laptop's `teenpehr` database (drop and create it first; `pg_restore --no-owner --no-privileges`), and copy
  `/data/media` and `/data/snapshots` back into `~/.local/share/teenpehr/`. It now has a migration journal,
  which `npm run db:push` ignores (push manages only the `public` schema). Reinstall the web unit
  (`cp infra/systemd/teenpehr-web.service ~/.config/systemd/user/`, then infra/README.md step 2), set
  `worker/.env` back to `SITE_URL=http://localhost:3000` and `WORKER_TOKEN` to the one in `web/.env.local`, and
  start the timers.

## Testing the image locally

With the compose database running and a throwaway database (never the dev database itself):

```bash
docker exec teenpehr-db createdb -U teenpehr tabayyun_imagetest
docker build -t tabayyun-web:test web/                           # podman: add --format docker to keep the HEALTHCHECK
docker run -d --name tabayyun-test --network pasta:-T,5432 -p 127.0.0.1:3107:3000 -v tabayyun-test-data:/data \
  -e DATABASE_URL=postgres://teenpehr:teenpehr@127.0.0.1:5432/tabayyun_imagetest \
  -e SITE_URL=http://localhost:3107 -e WORKER_TOKEN=$(openssl rand -hex 32) tabayyun-web:test
docker logs -f tabayyun-test                                      # entrypoint, migrate, Ready
```

(`--network pasta:-T,5432` is rootless podman's way to reach the host's 127.0.0.1:5432; with Docker, use
`--network host -e PORT=3107 -e HOSTNAME=127.0.0.1` instead of it and `-p`.) The session cookie is Secure in
production: a browser keeps it on `http://localhost`, but on any other plain-http address signing in fails;
the real site is https. Afterwards: `docker rm -f tabayyun-test && docker volume rm tabayyun-test-data &&
docker rmi tabayyun-web:test && docker exec teenpehr-db dropdb -U teenpehr tabayyun_imagetest`.
