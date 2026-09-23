# Worker ↔ Web API contract

The Python worker never touches Postgres. It talks to the Next.js app over these routes with
`Authorization: Bearer $WORKER_TOKEN`. Every request body is validated with zod
(`web/lib/contracts.ts` is the source of truth; this file mirrors it). All timestamps are ISO
8601 with offset. Errors return `{ "error": "<message>", "issues"?: [...] }` with 400/401/404/409.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/worker/health` | `{ ok: true, time }` preflight |
| GET | `/api/worker/config` | Everything the worker needs for a run (groups, sources, handles, topics, glossary, settings, recent threads) |
| POST | `/api/worker/runs` | Start a run → `{ id }` |
| PATCH | `/api/worker/runs/{id}` | Finish a run (status, cost, per-source results, log) |
| POST | `/api/worker/items` | Bulk upsert fetched articles → ids + whether each is new |
| POST | `/api/worker/posts` | Bulk upsert social posts → ids + whether each is new |
| GET | `/api/worker/posts?since=&group=` | Recent posts for a group (the X collector runs separately) |
| GET | `/api/worker/items?since=&group=` | Recent items for a group (overlap window from earlier runs) |
| PUT | `/api/worker/editions/{date}/{slot}` | Upsert an edition draft with its groups and stories (idempotent) |
| POST | `/api/worker/editions/{date}/{slot}/publish` | Publish (immutable afterwards), revalidate pages, notify |
| POST | `/api/worker/glossary` | Propose new glossary entries (unlocked; editor may lock) |
| POST | `/api/worker/handles/{id}/seen` | Record last post time / fallback use for a handle |

## GET /api/worker/config → 200

```json
{
  "settings": { "edition_times": {"subh":"07:00","dopahar":"13:00","shaam":"19:30"}, "timezone": "Asia/Karachi",
                "publish_policy": "auto", "site_name_en": "Teen Pehr", "digits_ur": "latn", "editor_name": "" },
  "groups": [ { "id": 1, "slug": "pakistan", "name_en": "Pakistan", "name_ur": "پاکستان", "order": 0,
                "brief": "...", "story_count": 8, "x_list_ids": ["1234567890"] } ],
  "sources": [ { "id": 10, "group_id": 1, "name": "Dawn", "kind": "rss", "url": "https://www.dawn.com/feeds/pakistan",
                 "lang": "en", "perspective": "Karachi English daily; liberal, often critical of the establishment",
                 "fetcher_tier": 0, "route": "direct", "max_items": 8, "fail_streak": 0 } ],
  "handles": [ { "id": 5, "group_id": 1, "platform": "x", "handle": "HamidMirPAK", "display_name": "Hamid Mir", "role": "journalist" } ],
  "topics": [ { "group_id": 1, "keywords_en": ["IMF", "budget"], "keywords_ur": ["آئی ایم ایف"], "boost": 2 } ],
  "glossary": [ { "term_en": "Shehbaz Sharif", "term_ur": "شہباز شریف", "kind": "person", "locked": true } ],
  "threads": [ { "id": 3, "slug": "imf-review-2026-09", "title_en": "IMF review", "title_ur": "...", "last_seen": "2026-09-23T02:05:00+00:00" } ]
}
```
`sources` and `handles` contain only active rows. `threads` covers the last 14 days.

## POST /api/worker/runs
Body `{ "kind": "edition" | "x_collect", "date"?: "2026-09-23", "slot"?: "subh" | "dopahar" | "shaam" }` → `201 { "id": 42 }`.
A second `edition` run for the same date+slot is allowed (retries); the edition PUT is what is idempotent.

## PATCH /api/worker/runs/{id}
```json
{ "status": "ok" | "failed" | "empty", "model": "claude-sonnet-5", "tokens_in": 120000, "tokens_out": 9000,
  "cost_usd": 0.43, "log": "…last lines…", "error": null,
  "sources": [ { "source_id": 10, "ok": true, "items": 24, "error": null, "ms": 812, "tier": 0, "route": "direct" } ] }
```
The server updates `sources.last_ok_at` / `fail_streak` from `sources[]`.

## POST /api/worker/items
```json
{ "run_id": 42, "items": [ { "source_id": 10, "url": "https://www.dawn.com/news/1234", "url_canonical": "dawn.com/news/1234",
  "title": "…", "text": "first ~2,000 chars or the feed summary", "published_at": "2026-09-23T01:10:00+05:00",
  "lang": "en", "content_hash": "sha256-hex" } ] }
```
→ `200 { "items": [ { "url_canonical": "dawn.com/news/1234", "id": 9001, "is_new": true } ] }`.
Upsert key is `url_canonical`. `is_new` is false when the item existed before this run (seen in an earlier run), which the worker uses for "since the last edition".

## POST /api/worker/posts
```json
{ "run_id": 43, "posts": [ { "platform": "x", "platform_id": "1837...", "author_handle": "HamidMirPAK", "author_name": "Hamid Mir",
  "text": "…", "url": "https://x.com/HamidMirPAK/status/1837...", "posted_at": "2026-09-23T03:00:00+00:00",
  "is_repost": false, "raw": {} } ] }
```
→ `200 { "posts": [ { "platform_id": "1837...", "id": 501, "is_new": true, "handle_id": 5 } ] }`. `handle_id` is matched by `author_handle` (case-insensitive) when the handle is on the watchlist; reposts from a watched handle keep `handle_id` of the watcher.

## GET /api/worker/posts?since=ISO&group=slug (or `handle=` / no filter) → `{ "posts": [ { "id", "handle_id", "author_handle", "author_name", "text", "url", "posted_at", "is_repost" } ] }` (newest first, max 500).
## GET /api/worker/items?since=ISO&group=slug → `{ "items": [ { "id", "source_id", "url", "title", "text", "published_at", "lang" } ] }` (max 1000).

## PUT /api/worker/editions/{date}/{slot}
```json
{ "run_id": 42, "status": "draft",
  "groups": [ { "group": "pakistan", "lead_en": "…", "lead_ur": "…", "item_count": 61,
    "stories": [ { "order": 0, "thread": "imf-review-2026-09" | null, "thread_title_en": "IMF review", "thread_title_ur": "…",
      "title_en": "…", "title_ur": "…", "summary_en": "…", "summary_ur": "…", "why_en": "", "why_ur": "",
      "tag": "must-read", "coverage": "broad", "contested_en": "", "contested_ur": "",
      "angles": [ { "item_id": 9002, "note_en": "…", "note_ur": "…" } ],
      "sources": [ { "item_id": 9001, "is_primary": true }, { "item_id": 9002, "is_primary": false } ],
      "posts": [ 501 ],
      "qa_status": "verified" | "flagged" | "pending", "qa_note": "" } ] } ] }
```
Rules enforced by the server (400 on violation): every `item_id` and `post_id` must exist; at least one source per story; `thread` slugs are created if missing (with the given titles) and `last_seen` bumped; groups are matched by slug. A PUT on a `published` edition returns 409. Response `200 { "edition_id": 7, "status": "draft", "stories": [ { "order": 0, "group": "pakistan", "id": 3001 } ] }`.

## POST /api/worker/editions/{date}/{slot}/publish
Body `{ "force"?: false }`. If `settings.publish_policy` is `hold`, or any story is `flagged` and `force` is false, the edition moves to `review` and the response is `200 { "status": "review", "flagged": 2 }`. Otherwise `status` becomes `published`, `published_at` is set, the edition JSON is written to `EDITION_SNAPSHOT_DIR` (default `web/snapshots/YYYY-MM-DD-slot.json`), pages are revalidated, and notifications fire → `200 { "status": "published", "published_at": "…", "url": "/en/2026-09-23/subh" }`. Publishing twice is a no-op 200.

## POST /api/worker/glossary
`{ "entries": [ { "term_en": "…", "term_ur": "…", "kind": "person" } ] }` → `{ "added": 3, "skipped": 1 }` (existing terms are never overwritten).

## POST /api/worker/handles/{id}/seen
`{ "last_post_at": "…", "fallback_used": false }` → `{ "ok": true }`.

## Authentication
`WORKER_TOKEN` (32+ random bytes, hex). Compared with a constant-time check. Missing or wrong → 401. These routes are excluded from locale routing and are never cached.
