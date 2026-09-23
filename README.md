# Teen Pehr (تین پہر) — working name

A bilingual (English + Urdu) news digest that comes out three times a day, written by an
agent from sources you choose, with every story traceable to the outlets and posts it came
from. Grown out of deskboard's Briefing widget.

The full research and plan: [docs/PLAN.md](docs/PLAN.md) (decisions) and
[docs/RESEARCH.md](docs/RESEARCH.md) (comparison tables, verified source pack). The live,
editable copy is the Claude Doc "Bilingual News Digest Plan".

## Layout

| Path | What |
| --- | --- |
| `web/` | Next.js 16 app: public site (en/ur, RTL, themes incl. Buzurg), admin, and the worker API |
| `worker/` | Python worker (Claude Agent SDK): collect → dedupe → curate → Urdu → QA → publish |
| `infra/systemd/` | User timers and services for the laptop (3 editions/day, X collector, alerts) |
| `docs/` | Plan, research, API contract |
| `compose.yaml` | Local Postgres 17 |

Production build for the laptop or a VPS: `cd web && npm run build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/ && node .next/standalone/server.js` (see `infra/systemd/teenpehr-web.service`).

## Quickstart

```bash
docker compose up -d db                 # Postgres on 127.0.0.1:5432
cp .env.example web/.env.local          # edit WORKER_TOKEN
cd web && npm install && npx drizzle-kit push --force && npm run db:seed && npm run dev
# http://localhost:3000/en · /ur · /admin (password: ADMIN_PASSWORD in web/.env.local)
# worker
cd ../worker && cp ../.env.example .env && uv sync && uv run teenpehr health
uv run teenpehr edition --dry-run --groups pakistan   # writes worker/out/<run_id>.json, publishes nothing
```

## Editions

Subh 07:00 · Dopahar 13:00 · Shaam 19:30 (Asia/Karachi). An edition is immutable once
published; corrections are appended.
