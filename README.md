# Tabayyun (تبیُّن)

*Verify before you believe* · *خبر کی تحقیق کر لیا کرو*

A bilingual (English + Urdu) news digest that comes out three times a day, written by an
agent from sources you choose, with every story traceable to the outlets and posts it came
from. The name is from Quran 49:6 ("if a news-bearer brings you a report, verify it"). The site
is invite-only. Grown out of deskboard's Briefing widget. Internal names (the `teenpehr` package
and CLI, systemd units, the database) keep the working title.

The full research and plan: [docs/PLAN.md](docs/PLAN.md) (decisions) and
[docs/RESEARCH.md](docs/RESEARCH.md) (comparison tables, verified source pack). The live,
editable copy is the Claude Doc "Bilingual News Digest Plan".

## Layout

| Path | What |
| --- | --- |
| `web/` | Next.js 16 app: invite-only reader site (en/ur, RTL, palettes and the Wazeh reading mode), admin, accounts, and the worker API |
| `worker/` | Python worker (Claude Agent SDK): collect → dedupe → curate → Urdu → QA → publish |
| `infra/systemd/` | User timers and services for the laptop (3 editions/day, X collector, alerts) |
| `docs/` | Plan, research, API contract, deployment runbook |
| `compose.yaml` | Local Postgres 17 |

The live site runs as one Docker image (`web/Dockerfile`) on the Hetzner server under Coolify, at
https://tabayyun.code19.dev: [docs/DEPLOY.md](docs/DEPLOY.md). Production build on the laptop instead: `cd web && npm run build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/ && node .next/standalone/server.js` (see `infra/systemd/teenpehr-web.service`). On the laptop, [infra/README.md](infra/README.md) sets up the whole stack as user units that come back after a reboot: the database, the web app, the edition and X timers, and ntfy alerts.

## Quickstart

```bash
docker compose up -d db                 # Postgres on 127.0.0.1:5432
cp .env.example web/.env.local          # edit WORKER_TOKEN
cd web && npm install && npm run db:push -- --force && npm run db:seed && npm run dev
npm run user:invite -- --email you@example.com --role owner   # prints a one-time link: open it, set a password
# http://localhost:3000/en · /ur · /admin (editors and owners)
# worker
cd ../worker && cp ../.env.example .env && uv sync && uv run teenpehr health
uv run teenpehr edition --dry-run --groups pakistan   # writes worker/out/<run_id>.json, publishes nothing
```

## Editions

Subh 07:00 · Dopahar 13:00 · Shaam 19:30 (Asia/Karachi). An edition is immutable once
published; corrections are appended.
