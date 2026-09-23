# web/

The Next.js app: public site (`app/[locale]`), admin (`app/admin`), worker API (`app/api/worker`).
See the root [README](../README.md), [docs/PLAN.md](../docs/PLAN.md) and [docs/API.md](../docs/API.md).

```bash
npm run dev          # http://localhost:3000/en · /ur · /admin
npm run typecheck && npm run lint && npm run build
npx drizzle-kit push --force && npm run db:seed   # schema + seed data (db/seed/*.json)
npm run fonts        # re-download and subset the self-hosted fonts
python3 scripts/smoke.py   # end-to-end check of the worker API against a running server
```
