# Worker ↔ Web API contract

The Python worker never touches Postgres. It talks to the Next.js app (Tabayyun) over these routes with
`Authorization: Bearer $WORKER_TOKEN`. These routes are outside the reader login wall (decision D2 in
`docs/PLAN.md`): the bearer token is their only gate. Every request body is validated with zod
(`web/lib/contracts.ts` is the source of truth; this file mirrors it). All timestamps are ISO
8601 with offset. Errors return `{ "error": "<message>", "issues"?: [...] }` with 400/401/404/409.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/worker/health` | `{ ok: true, time, groups, database }` preflight |
| GET | `/api/worker/config` | Everything the worker needs for a run (groups, sources, handles, topics, glossary, settings, recent threads) |
| POST | `/api/worker/runs` | Start a run → `{ id }` |
| PATCH | `/api/worker/runs/{id}` | Finish a run (status, cost, per-source results, log); idempotent |
| POST | `/api/worker/runs/{id}/outputs` | Keep each Claude call's structured output (audit, prompt work) |
| POST | `/api/worker/items` | Bulk insert fetched articles (existing ones untouched, every feed's sighting recorded) → ids + whether each is new |
| POST | `/api/worker/posts` | Bulk upsert social posts → ids + whether each is new |
| GET | `/api/worker/posts?since=&group=` | Recent posts for a group (the X collector runs separately) |
| GET | `/api/worker/items?since=&group=` | Items a group's feeds carried recently (a feed that answers 304 reads its items back) |
| GET | `/api/worker/editions/{date}/{slot}` | Status of a slot's edition, so a run can skip a published or held slot |
| POST | `/api/worker/images` | Upload one publisher image of a cited item or post (re-encoded WebP variants) → `{ image_id, created }` |
| PUT | `/api/worker/editions/{date}/{slot}` | Upsert an edition draft with its groups and stories (idempotent; `partial` for single groups) |
| POST | `/api/worker/editions/{date}/{slot}/publish` | Publish (immutable afterwards), revalidate pages, notify |
| POST | `/api/worker/glossary` | Propose new glossary entries (unlocked; editor may lock) |
| POST | `/api/worker/handles/{id}/seen` | Record last post time / fallback use for a handle |
| POST | `/api/worker/jobs/claim` | Lease the next queued job of the given kinds → `{ job }` or `{ job: null }` (§ Jobs) |
| GET | `/api/worker/jobs/{id}/context` | Everything the worker needs for one job (item, story, locked glossary) |
| POST | `/api/worker/jobs/{id}/done` | Report a job's result; the site validates it for the kind and applies it |
| POST | `/api/worker/jobs/{id}/fail` | Report a failure: retry after a backoff, fail for good, or blocked |

## GET /api/worker/config → 200

```json
{
  "settings": { "edition_times": {"subh":"07:00","dopahar":"13:00","shaam":"19:30"}, "timezone": "Asia/Karachi",
                "publish_policy": "publish", "site_name_en": "Tabayyun", "digits_ur": "latn", "editor_name": "" },
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
`settings.publish_policy` (decision D14 in `docs/PLAN.md`; `web/lib/codes.ts` `PUBLISH_POLICIES`) is `publish` (the
default: publish every edition at once, flagged stories included), `auto` (hold an edition with a flagged story) or
`hold` (hold every edition); the publish route applies it, the worker only reads it. `editor_name` is the editor in
charge named in the site footer. `sources` and `handles` contain only active rows; archived sources (`sources.archived_at` set) are left out even
when active. `glossary` is ordered locked first, then by `term_en`, so a prompt cap drops unreviewed terms before
locked ones. `threads` covers the last 14 days.

## POST /api/worker/runs
Body `{ "kind": "edition" | "x_collect", "date"?: "2026-09-23", "slot"?: "subh" | "dopahar" | "shaam" }` → `201 { "id": 42 }`.
A second `edition` run for the same date+slot is allowed (retries); the edition PUT is what is idempotent.
This is the one write the server does not deduplicate, so the worker replays it only when the request never
reached the server (connection refused or connect timeout), never after a read timeout.
Each call also closes out runs still `running` more than 6 hours after they started (longer than any systemd unit
lets a run live): they become `failed` with `error: "abandoned: the worker never reported a result"`.

## PATCH /api/worker/runs/{id}
```json
{ "status": "ok" | "failed" | "empty" | "skipped", "model": "claude-sonnet-5" | null, "tokens_in": 120000, "tokens_out": 9000,
  "cost_usd": 0.43, "log": "…last lines…", "error": null,
  "sources": [ { "source_id": 10, "ok": true, "items": 24, "error": null, "ms": 812, "tier": 0, "route": "direct" } ] }
```
→ `200 { "ok": true }`. `model` is optional and may be `null` (X collector runs, and edition runs where no Claude call
succeeded). `skipped` means the slot was already published or held for review, so the run did nothing billable.
The server records `sources[]` as run_sources rows and updates `sources.last_ok_at` / `fail_streak` from them.

Idempotent: the run row is locked, and once it has `finished_at` any further PATCH returns
`200 { "ok": true, "already": true }` without recording sources again or touching fail streaks, so a retry after a
timeout is safe. An unknown run id is 404. A `source_id` with no row in `sources` is
`400 { "error": "unknown source ids: …", "issues": { "sources": [ids] } }` and nothing is recorded (drop those
entries and PATCH again).

## POST /api/worker/items
```json
{ "run_id": 42, "items": [ { "source_id": 10, "url": "https://www.dawn.com/news/1234", "url_canonical": "dawn.com/news/1234",
  "title": "…", "text": "first ~2,000 chars or the feed summary", "published_at": "2026-09-23T01:10:00+05:00",
  "lang": "en", "content_hash": "sha256-hex",
  "author": "Staff Reporter", "categories": ["Pakistan", "Business"], "image_url": "https://…/cover.jpg",
  "description": "the feed's own summary", "word_count": 640, "lang_detected": "en", "guid": "https://www.dawn.com/news/1234",
  "feed_updated_at": "2026-09-23T01:12:00+05:00", "site_name": "Dawn",
  "fetch": { "route": "direct", "tier": 0, "status": 200, "ms": 412, "via": "rss" },
  "raw": { "…": "a small subset of the feed entry" } } ] }
```
Everything after `content_hash` is optional metadata for trend analysis and search (decision D5: items are kept
forever). Text fields are trimmed and cut to their limits (author 300, description 5,000, guid 2,000, site_name 200,
each category 100 and at most 30 of them), never rejected for length; an `image_url` that is not http(s) is stored as
null; `raw` over 16 KB of JSON is dropped (stored as null). `fetch` is how the worker got the item: `route`
`direct`|`germany`, `tier` 0–3, the HTTP `status`, `ms`, and `via` (a short word such as `rss`, `gnews`, `article`).
Like `title` and `text`, the metadata is written when the item is first stored and never rewritten.
→ `200 { "items": [ { "url_canonical": "dawn.com/news/1234", "id": 9001, "is_new": false,
  "stored": { "title": "…", "text": "…", "published_at": "2026-09-23T01:10:00+05:00" } } ] }` (one entry per `url_canonical`).
Key is `url_canonical`. An item that already exists is returned with its id and never rewritten: `title`, `text` and
`published_at` stay as first stored, because published stories cite what the agent saw (an outlet editing its
headline later must not change an archived edition). Such an item carries `stored`, those first-stored fields, and
the worker builds its prompts from them so a story says what its citation shows; `stored` is absent for items
inserted by this request. When one `url_canonical` appears several times in a request (the same article in two
groups' feeds, with different `source_id`s), the first copy is the one stored.

Every `(source_id, url_canonical)` pair in the request is recorded as a sighting (`item_sources`: first and last
seen per feed). `items.source_id` is only the feed that stored the item first; the sightings are how a feed that
answers 304 gets back items another group's feed stored, and they record which outlets carried a story.

`is_new` is true when the item was first stored by this `run_id` (so a retried request gives the same answer) and
false when an earlier run stored it; the worker uses it for "since the last edition". Without `run_id`, `is_new` is
true only for rows inserted by this request.

Research bookkeeping (D5), for items that already exist as well as new ones:
- `items.last_seen_at` becomes the time of the request (it equals the newest `item_sources.last_seen_at`) and
  `items.seen_count` goes up by one per request that carries the item.
- An existing item whose incoming `title` differs from its latest known title, or whose `text` hash differs from its
  latest known one, gets an `item_revisions` row (title, sha256 of the text, time). The item itself keeps what was
  first stored; the revisions are the headline history.
- With `run_id`, `run_items` gets one row per item and group of each feed that carried it (`group_id` of the
  sighting's source, `is_new` as returned): which items the run saw. The worker posts every item it feeds to
  curation, including a 304 feed's read-back items (existing, so nothing is rewritten; they get a sighting and a
  `run_items` row), which is why `GET /items` also returns `url_canonical` and `content_hash`. It also posts each
  feed's own copy of an article another feed of the same group claimed first (same `url_canonical`; not given to
  curation), so every feed that carried an article records its sighting, and the item's own feed is compared for
  revisions on every run. A `source_id` with no row in `sources` is
`400 { "error": "unknown source ids: …", "issues": { "sources": [ids] } }` and nothing in the request is stored (the
worker drops those items and sends the rest). Archived sources still exist, so their items are accepted.

## POST /api/worker/posts
```json
{ "run_id": 43, "posts": [ { "platform": "x", "platform_id": "1837...", "author_handle": "HamidMirPAK", "author_name": "Hamid Mir",
  "text": "…", "url": "https://x.com/HamidMirPAK/status/1837...", "posted_at": "2026-09-23T03:00:00+00:00",
  "is_repost": false, "raw": {},
  "lang": "ur", "metrics": { "replies": 12, "reposts": 40, "likes": 310, "quotes": 3, "views": 21000, "bookmarks": 5 },
  "hashtags": ["IMF"], "mentions": ["dawn_com"], "urls": ["https://www.dawn.com/news/1234"],
  "media": [ { "type": "photo", "url": "https://pbs.twimg.com/…", "preview_url": "https://…", "alt": "…" } ],
  "in_reply_to": "1837…", "conversation_id": "1837…" } ] }
```
Everything after `raw` is optional. Hashtags and mentions lose a leading `#`/`@`; lists are de-duplicated and cut
(50 hashtags, 50 mentions, 20 urls, 10 media); a url or media entry that is not a valid http(s) URL is dropped rather
than failing the request. Present fields replace the stored ones and absent ones are left alone; `metrics` is the
latest count seen. `posts.last_seen_at` is set on every upsert.
→ `200 { "posts": [ { "platform_id": "1837...", "id": 501, "is_new": true, "handle_id": 5 } ] }`. `handle_id` is matched by `author_handle` (case-insensitive) when the handle is on the watchlist; reposts from a watched handle keep `handle_id` of the watcher.
Key is `platform` + `platform_id`. An existing post takes the new `text` and `author_name`, unless a story already
cites it: then both stay as first stored, so a published edition never changes when a post is collected again.
`raw.x_list_id` (set by `collect-x` on every post an X List returned) names the list that carried the post; it is
kept when the post is seen again. A post whose author is not a watched handle belongs to the group whose approved
`x_list_ids` include that list (D10: a public list's members count for that group on the X board and in its posts).
Bluesky posts (`platform: "bluesky"`, `url` on bsky.app) come from the watched Bluesky accounts, read by `collect-x`.

## GET /api/worker/posts?since=ISO&group=slug (or `handle=` / no filter) → `{ "posts": [ { "id", "handle_id", "author_handle", "author_name", "text", "url", "posted_at", "is_repost", "platform", "media" } ] }` (newest first, max 500).
`group=` returns the group's watched handles' posts and the posts its approved X Lists carried (`raw.x_list_id` in
the group's `x_list_ids`). `media` is the post's stored media list (the `POST` shape, or null when none was sent): a
cited post's first photo can be its story's image (D6).
## GET /api/worker/items?since=ISO&group=slug → `{ "items": [ { "id", "source_id", "url", "url_canonical", "content_hash", "title", "text", "published_at", "lang", "image_url" } ] }` (max 1000, newest published first).
One row per sighting last seen at or after `since` by a feed of that group; `source_id` is the feed that saw it, so an
article carried by two of the group's feeds comes back once per feed. `title`/`text`/`published_at` are as first
stored, and `image_url` is the feed's lead image as first stored (or null), so an item read back this way keeps its
image candidate (D6). The worker calls it for a feed that answered 304 and keeps that feed's rows inside its window.

## GET /api/worker/editions/{date}/{slot}
→ `200 { "edition_id": 7, "status": "draft" | "review" | "published", "groups": ["pakistan", "world"] }` (slugs of the
groups the worker has written, in front-page order: a group row kept only for editors' manual stories, D12, is left
out), or `404 { "error": "not found" }` when the slot has no edition yet. An edition row may exist before any run
(the admin creates the upcoming draft to hold a manual or desk story); it is an ordinary draft. The worker calls it
before collecting so it can skip a slot that is published or held without spending anything.

## PUT /api/worker/editions/{date}/{slot}
```json
{ "run_id": 42, "status": "draft", "partial": false,
  "groups": [ { "group": "pakistan", "lead_en": "…", "lead_ur": "…", "item_count": 61,
    "stories": [ { "order": 0, "thread": "imf-review-2026-09" | null, "thread_title_en": "IMF review", "thread_title_ur": "…",
      "title_en": "…", "title_ur": "…", "summary_en": "…", "summary_ur": "…", "why_en": "", "why_ur": "",
      "tag": "must-read", "coverage": "broad", "contested_en": "", "contested_ur": "",
      "angles": [ { "item_id": 9002, "note_en": "…", "note_ur": "…" } ],
      "sources": [ { "item_id": 9001, "is_primary": true }, { "item_id": 9002, "is_primary": false } ],
      "posts": [ 501 ],
      "qa_status": "verified" | "flagged" | "pending", "qa_note": "",
      "keywords": ["IMF", "loan tranche"], "topics": ["economy", "diplomacy"], "countries": ["PK", "US"],
      "places": ["Islamabad"], "event_type": "agreement" | null,
      "entities": [ { "name_en": "International Monetary Fund", "name_ur": "آئی ایم ایف", "kind": "org", "role": "lender", "salience": 0.9 } ],
      "image_id": 71 | null } ] } ] }
```
`run_id` is optional here and on `POST /items` and `POST /posts` (null or absent: the request belongs to no run).
`image_id` (optional, null or absent for none) is an image from `POST /api/worker/images` whose `item_id` is one
of the story's `sources` or whose `post_id` is one of its `posts`: an unknown id is
`400 { "error": "unknown image ids", "issues": { "images": [ids] } }`, and an image of anything the story does not
cite is `400 { "error": "image not from an item or post its story cites", "issues": [ { "group", "order", "image_id" } ] }`.
Research metadata (D5), all optional (absent means none): `keywords` (at most 20, each cut to 60 characters),
`topics` (slugs from `web/lib/taxonomy.ts` `TOPICS`; an unknown slug is a 400), `countries` (ISO 3166-1 alpha-2,
upper-cased), `places` (at most 20), `event_type` (one of `EVENT_TYPES` in the same file, or null), and `entities`
(at most 40; `kind` is `person|org|place|event|other`, `salience` 0–1, `role` a short free word). Like every story
field they must come from the run's items, never from memory. The server upserts each entity into `entities` by a slug
of `name_en` (fills an empty `name_ur`, never overwrites one) and links it through `story_entities`; an entity's
`first_seen_at`, `last_seen_at` and `mention_count` count published stories, so they move when the edition is
published, not on every draft PUT. `stories.word_count` and `reading_time_sec` are computed by the server from the
English text.
Rules enforced by the server (400 on violation): every `item_id` and `post_id` must exist; at least one source per story; `thread` slugs are created if missing (with the given titles) and `last_seen` bumped; groups are matched by slug and may appear only once. A new thread without `thread_title_en` takes the story's `title_en`; without `thread_title_ur` its Urdu title stays `""` (never one story's headline) until a later story supplies one. Thread titles are stored as one plain line (control characters and line breaks become spaces): they are shown back to the curate pass. Response `200 { "edition_id": 7, "status": "draft", "stories": [ { "order": 0, "group": "pakistan", "id": 3001 } ] }`.

Only a `draft` (or missing) edition can be written. The edition row is read `SELECT … FOR UPDATE` inside the
transaction, and both publish paths take the same lock, so a PUT and a publish never interleave:
- `published` → `409 { "error": "edition is published" }` (immutable; corrections are appended in the admin).
- `review` → `409 { "error": "edition is in review" }`. A hold belongs to the editor; the admin's "release hold"
  moves it back to `draft`, after which the worker may rerun the slot.

By default the PUT replaces all of the draft's groups and stories, and groups are laid out in payload order. With
`"partial": true` only the groups present in the payload are replaced; the draft's other groups and their stories
stay, and all of the edition's groups are then laid out in the configured group order (`groups.order`).

Editors' manual stories (`stories.origin = 'manual'`, decision D12) are never replaced: the PUT deletes only the
worker's own stories (`origin = 'ai'`) of the groups it replaces, so a rerun keeps every manual story. A group left
with only manual stories keeps an `edition_groups` row with an empty lead; when such a row has to be added, the
edition's groups are laid out in the configured group order. The response lists only the PUT's own stories.

## POST /api/worker/editions/{date}/{slot}/publish
Body `{ "force"?: false, "notify"?: true }`. The edition row is locked for the whole decision, so the stories counted
are the ones published. An edition already in `review` stays there → `200 { "status": "review", "flagged": 1 }`: only
the admin publishes a held edition, even with `force`. A draft follows `settings.publish_policy` (D14): `publish`, the
default, publishes it even when stories are `flagged` (each then shows readers "Check raised a question" with its
`qa_note` until an editor reviews it; every story shows "Not reviewed yet" until then); `auto` moves it to `review` when
any story is `flagged` and `force` is false; `hold` always moves it to `review` (same response shape). An edition with
no stories is 400; a missing one is 404. Otherwise `status` becomes `published` (guarded on the status just read),
`published_at` is set, the edition JSON is written to `$EDITION_SNAPSHOT_DIR/YYYY-MM-DD-slot.json` (each story with
its `image`: `id, sha256, itemId, postId, sourceId, credit, alt, width, height, color, graphic, variants[{w, h, file,
bytes, mime}]`, or null, and `imageHiddenAt`; never the download URL), pages are
revalidated, and notifications fire (with `notify`, the site's ntfy message says how many stories went out and how many
of them QA flagged, awaiting review) → `200 { "status": "published", "published_at": "…", "url": "/en/2026-09-23/subh",
"stories": 12, "flagged": 2 }`: `stories` is how many stories readers see in the edition (withdrawn ones not counted),
`flagged` how many of them QA flagged. Publishing twice is a no-op 200 with the original `published_at` and the
current counts.

Review happens after publication (D14): an editor marks each story reviewed on the admin's Review page
(`stories.reviewed_at`/`reviewed_by`), or withdraws it (`withdrawn_at`/`withdrawn_by`, `withdraw_note_en`/`_ur`), which
takes it out of everything readers see; none of this changes a published story's text. The worker takes no part.

Publishing also settles the Editor's desk (D12, `web/lib/desk.ts` `joinDeskStories`, inside the same locked
transaction, after the hold checks): manual stories of this edition that are not ready (a language still missing, or a
`fill_language`/`story_image` job for them still queued or running) move to the upcoming unpublished edition instead
of going out half-made, and every live desk story (`stories.desk_at` set) hosted in another unpublished edition moves
into this one, so it joins the next edition that publishes. An edition locked by another transaction at that moment
(a PUT in progress) is skipped and its desk stories wait for the next publish. An edition whose only stories are
unready manual ones is `400 { "error": "edition has no stories ready to publish …" }` and nothing moves. The stories
count and the snapshot include the stories that joined.

`EDITION_SNAPSHOT_DIR` must be an absolute path. When it is unset (or relative, which is logged and ignored) the
default is `~/.local/share/teenpehr/snapshots`, never a path under `process.cwd()`: the standalone server runs from
`.next/standalone/`, which every build wipes. The directory in use is logged on the first publish. The admin's
Publish button goes through the same code (`web/lib/admin/publish.ts`), minus the policy and hold checks (a flagged
edition needs its "publish despite flagged" box there, as under `auto`).

## POST /api/worker/images
One publisher image for a story, already downloaded, checked and re-encoded by the worker (decisions I1–I6 in
`docs/PLAN.md` D6). Only the image of an item or post a story cites; never an AI-made image; `alt` only from the
publisher (og:image:alt, a post's media description), never written by a model.
```json
{ "sha256": "<64 lower-case hex: SHA-256 of the image as downloaded>", "source_url": "https://www.dawn.com/…/photo.jpg",
  "item_id": 9001, "post_id": null, "source_id": 10,
  "credit": "Dawn", "alt": "Protesters outside the Karachi Press Club" | null, "graphic": false,
  "color": "#5a4632", "width": 1600, "height": 900,
  "variants": [ { "w": 480, "h": 270, "mime": "image/webp", "data_base64": "UklGR…" },
                { "w": 960, "h": 540, "mime": "image/webp", "data_base64": "UklGR…" } ] }
```
- Exactly one of `item_id` (a stored item) and `post_id` (a stored post). `source_id` goes only with `item_id`: a feed
  that carried the item (`items.source_id` or an `item_sources` row); absent, it is the item's own feed.
- `credit`: the outlet's name as the story shows it (the item's feed name; for a post, its author's display name),
  one line, cut to 120 characters, not empty. `alt`: one line, cut to 500 characters; empty is null.
- `graphic`: the vision check's answer; `true` whenever the check failed or did not answer (fail safe).
- `color`: dominant colour `#rrggbb` (stored lower-case), the placeholder while the file loads. `width`/`height`: the
  downloaded image's pixel size after EXIF orientation, 1–20000.
- `variants`: 1–2, distinct widths, `w` 64–1200 and never above `width` (no upscaling), `h` within 2 px of
  `w × height / width`, `mime` `image/webp`, `data_base64` canonical base64 of at most 600 KB decoded. The server
  checks every variant's bytes before writing anything: a RIFF/WEBP file whose chunks tile it exactly, a single frame
  (no ANIM/ANMF), no EXIF or XMP chunk, and a frame header of exactly `w × h`; anything else (PNG, SVG, animated WebP,
  a truncated file) is a 400. The body is capped at about 1.7 MB (413 over it).

Files are written to `$MEDIA_DIR/<sha256>-<w>.webp` (content-addressed; temporary file then rename; an existing valid
file of that name is kept) and the row goes to `images`. Idempotent per `(sha256, item_id)` or `(sha256, post_id)`:
the first upload is `201 { "image_id": 71, "created": true }`; a repeat (a retry, a rerun) is
`200 { "image_id": 71, "created": false }` and changes nothing, so the first `graphic`, `alt` and `credit` stay. The same
picture used by two outlets is two rows over the same files, each with its own credit. Unknown owners are 400; a
failure to write the files is 500 and stores no row.

Readers get the files only from `GET /media/<sha256>-<w>.webp`: signed in (the proxy walls it and the route checks
the session again; signed out is a 401, never the sign-in page), names matching `^[0-9a-f]{64}-[1-9][0-9]{1,3}\.webp$`
only (anything else 404), `Content-Type: image/webp`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private, max-age=31536000, immutable`. A reader (role `reader`) gets a file only while a story of a
published edition shows it (an image with that `sha256`, of an item or post the story cites, not hidden by an editor);
otherwise 404, as for a missing file. Editors and owners get any stored file (drafts and hidden images in the admin).
Publisher URLs are never shown or linked to readers (no hotlinking); `source_url` stays in the database.
Signing out (`POST /api/auth/logout`) sends `Clear-Site-Data: "cache"`, so the year-long browser copies go with the
session.

`MEDIA_DIR` must be an absolute path; unset (or relative, logged and ignored) it is `~/.local/share/teenpehr/media`,
like `EDITION_SNAPSHOT_DIR`.

## POST /api/worker/runs/{id}/outputs
```json
{ "outputs": [ { "group": "pakistan", "stage": "curate", "model": "claude-sonnet-5", "tokens_in": 41000, "tokens_out": 3900,
  "cost_usd": 0.17, "output": { "lead": "…", "stories": [ … ] } } ] }
```
→ `201 { "ids": [ 12 ] }`. One entry per Claude call: `stage` is `curate`, `urdu`, `qa` or `image`; `group` is the group slug,
absent or null for a call that covers every group; `output` is the call's structured output as parsed (any JSON
except null, at most 256 KB each, 1–100 entries per request). Stored in `run_outputs` for audits and prompt work;
readers never see it. An `image` entry is one story image's vision check (D6): `output` is
`{ "order", "sha256", "source_url", "graphic", "placeholder_or_logo", "checked", "reason", "shown", "image_id" }`, where
`reason` is `checked` for an answer or why there was none (`failed: …`, `no answer in 90 s`, `check off`,
`daily usage ceiling reached`; then `graphic` is true, fail safe), and `shown`/`image_id` say whether the story kept
the picture. An unknown run id is 404; an unknown group slug is
`400 { "error": "unknown groups", "issues": [slugs] }` and nothing is stored. Not deduplicated: like `POST /runs`, the
worker replays it only when the request never reached the server.

## POST /api/worker/glossary
`{ "entries": [ { "term_en": "…", "term_ur": "…", "kind": "person" } ] }` → `{ "added": 3, "skipped": 1 }` (existing terms are never overwritten).

## GET /api/worker/health
→ `200 { "ok": true, "time": "…", "groups": 6, "database": "teenpehr" }`. `database` is the Postgres database the
app is connected to; `web/scripts/smoke.py` refuses to run unless it ends in `_smoke`, because the smoke test
publishes fabricated editions.

## POST /api/worker/handles/{id}/seen
`{ "last_post_at": "…", "fallback_used": false }` → `{ "ok": true }`.

## Jobs
Work the site asks of the worker between editions (decisions D9 and D12 in `docs/PLAN.md`): a full-article Urdu
translation a reader asked for, a manual story's missing language, a manual story's image from its link. The site
queues them (`web/lib/jobs.ts` `enqueueJob`), the worker polls, and results come back through these routes, which
apply them. `web/lib/contracts.ts` holds every payload and result schema; the worker's pydantic mirrors are `Job`,
`JobContext`, `TranslateArticleDone`, `TranslateArticleBlockedResult`, `FillLanguageResult` and `StoryImageResult` in
`worker/src/teenpehr/models.py`, and `WorkerApi.claim_job`/`job_context`/`job_done`/`job_fail` call them.

| `kind` | `payload` | Done `result` | Applied to |
| --- | --- | --- | --- |
| `translate_article` | `{ "item_id": 9001, "lang": "ur" }` | `{ "title", "body", "source_words", "source_text_hash"?, "check_ok", "check_note", "model", "tokens_in", "tokens_out", "cost_usd" }`, or blocked: `{ "blocked": { "reason", "note"? }, "model"?, … }` | `article_translations` row (item, `ur`): `done` with the text, or `blocked` with `blocked_reason` |
| `fill_language` | `{ "story_id": 3001, "lang": "ur" }` (the side to write) | `{ "fields": { "ur": { "title", "summary", "why"?, "contested"? } }, "model", "tokens_in", "tokens_out", "cost_usd" }` | The story's empty `*_ur` (or `*_en`) fields only, never over an editor's text; `stories.language_filled` = the side |
| `story_image` | `{ "story_id": 3001, "item_id": 9100 }` (the manual story's link item) | `{ "image_id": 71 | null, "note"? }` | `stories.image_id`, when the story has none and the image is of an item or post it cites |

Job states: `queued` → `running` (claimed: `attempts` + 1, lease in `locked_until`) → `done`, `blocked` (final: the work
cannot be done legitimately, never retried harder) or `failed` (final), or back to `queued` after a retryable failure.
Dedupe keys (`web/lib/jobs.ts` `jobKeys`): `translate:<item_id>:ur`, `fill:<story_id>:<lang>`, `image:<story_id>`; a
request for a key that exists returns that job, and one that failed for good is queued again with fresh attempts.

### POST /api/worker/jobs/claim
`{ "kinds": ["translate_article"], "worker_id": "laptop-1234", "lease_s": 600 }` (`lease_s` 60–3600, default 600;
`worker_id` letters, digits and `. _ : @ -`). First, running jobs whose lease ran out with no attempts left become
`failed` (their translation row too). Then the highest-`priority`, oldest job of those kinds that is `queued` with
`run_after` passed, or `running` with its lease run out and attempts left, is taken with `SELECT … FOR UPDATE SKIP
LOCKED`, so two workers never get the same job. → `200 { "job": { "id", "kind", "payload", "priority", "attempts",
"max_attempts", "locked_by", "locked_until", "requested_by", "created_at" } }` or `200 { "job": null }`. Claiming a
`translate_article` job marks its translation `running`. Every claim counts an attempt, so the worker does not replay
this call after a read timeout (an answer lost in transit leaves the job leased until the lease runs out).

### GET /api/worker/jobs/{id}/context
→ `200 { "job": { "id", "kind", "status", "payload", "attempts", "max_attempts", "locked_by", "locked_until" }, … }`:
- `translate_article`: `item` `{ id, url, url_canonical, title, lang, published_at, description, image_url, site_name,
  author, source: { id, name, kind, route, lang, url, perspective, fetcher_tier } }` (fetch it on `source.route`),
  `translation` `{ status, source_text_hash, finished_at }` or null, `glossary` (locked entries `{ term_en, term_ur, kind }`).
- `fill_language`: `story` `{ id, origin, placement, tag, title_en, title_ur, summary_en, summary_ur, why_en, why_ur,
  contested_en, contested_ur, language_filled, created_by_name, image_id, desk_at, edition_status, group: { slug,
  name_en, name_ur } }`, `sources` (the cited items, each an `item` as above plus `is_primary`), `glossary`.
- `story_image`: `story` as above, `item` (the payload's item, whose page's lead image to fetch), `sources`.
Unknown job, item or story: 404. Everything here is data for a prompt, an editor's text included, never instructions.

### POST /api/worker/jobs/{id}/done
`{ "worker_id"?: "laptop-1234", "result": { … } }` (body at most about 664 KB). The result is validated against the
job's kind (a translation against the branch it claims, blocked or done): a mismatch is `400` with `issues` (paths
start at `result`) and the job stays `running`, so the worker can send a corrected result or `fail`. Otherwise the
result is applied in the same transaction that marks the job `done` (or `blocked` for a blocked translation), and →
`200 { "ok": true, "status": "done" | "blocked" | "failed", "applied": true | false, "note"? }`. `applied: false`
means the site refused the result for good and failed the job with the reason (its story went live meanwhile: a live
story is never edited; the item or story is gone): do not retry. The job row keeps a summary of the result (a
translation's text lives only in `article_translations`).
- Translations are stored normalised to Urdu code points (ی ک ہ). A new `done` replaces an earlier one (the article
  changed); a `blocked` never replaces a `done` translation readers already have.
- `fill_language` writes only the payload's language and only fields that are empty (never over an editor's text),
  refuses a live story (`applied: false`), and needs `result.fields.<lang>` (else `400`). Filling English recomputes
  `word_count` and `reading_time_sec`.
- `story_image` sets `stories.image_id` only when the story has no image and the image (uploaded first through
  `POST /api/worker/images`) belongs to an item or post the story cites (else `400`); `image_id: null` is a normal
  "no usable image".
- When a `fill_language` or `story_image` job ends (done, failed or blocked), a `desk` story that is now ready goes live
  (`stories.desk_at`), and reader pages are revalidated.

A report for a job that is already `done` or `blocked` → `200 { …, "already": true }` and changes nothing. A job that
is `queued` or `failed` → `409` (claim it first). A `worker_id` that differs from the lease holder's → `409` (your lease
expired and another worker claimed the job). Unknown job → 404.

### POST /api/worker/jobs/{id}/fail
`{ "worker_id"?, "error": "…", "retry": false, "blocked"?: false, "reason"?: "paywalled", "retry_after_s"?: 300 }`.
`blocked: true` is final and needs `retry: false`: for a translation, `reason` is one of `paywalled`,
`robots_disallowed`, `unreachable`, `needs_germany`, `no_text`, `too_long`, `not_article` (default `unreachable`) and
lands in `article_translations.blocked_reason`, with `error` as the note. Otherwise `retry: true` with attempts left
queues the job again after `retry_after_s` or a backoff of 1, 2, 4 … minutes (at most an hour) →
`200 { "ok": true, "status": "queued", "retry_at": "…" }`; else the job is `failed` for good (a translation's row too)
→ `200 { "ok": true, "status": "failed" }`. Same 404/409/`already` rules as `done`.

The fetch behind `translate_article` and `story_image` follows the worker's usual etiquette (D9): robots.txt, 429
cooldowns, one request per host at a time, the source's route, and the Germany route only for reach. A paywall, a robots.txt disallow or a host blocked from Pakistan while the Germany route is down is a `blocked`
result, never a reason to evade.

## Implementation notes (D5 research metadata)
How the routes apply the research fields above, where the contract leaves a choice:
- **POST /items**: a `run_id` with no row in `runs` is `404 { "error": "run not found" }` and nothing is stored.
  Revisions compare only the copy from the item's own feed (the `source_id` that first stored it): another feed's
  wording of the same URL (a Google News title, a second section feed) is a sighting, not a revision. A headline
  change is compared with runs of whitespace collapsed. A text change counts only when the incoming `fetch.via`
  equals the stored item's `fetch.via` (a feed summary is never compared with an article body fetched another
  time); a headline-only revision keeps the previous comparable `text_hash`. A copy sent with `fetch.status` 304
  (the worker's read-back of a 304 feed from GET /items) is the stored text, so it bumps `last_seen_at`/`seen_count`
  and records the sighting but never makes a revision. An empty metadata string is stored as null.
- **POST /posts**: posts are upserted in batches that share the set of metadata fields present, so each field the
  request carries replaces the stored value and an absent one is left alone; an explicit `null` (`lang`, `metrics`,
  `media`, `in_reply_to`, `conversation_id`) clears it.
- **PUT …/editions**: an entity is one `(kind, slug)` pair, where the slug is `name_en` in ASCII lower case with
  hyphens (`e-<hash>` for a name with no Latin letters); the URL slug is that, or `<slug>-<kind>` when another kind
  already holds it ("Punjab" the place and "Punjab" as `other` are two rows). Another English spelling with the same
  slug is kept in `aliases` (at most 20); `name_ur` is normalised to Urdu code points. The same entity twice in one
  story is one `story_entities` row with the higher salience. `word_count` and `reading_time_sec` count
  `title_en`, `summary_en`, `why_en` and `contested_en` at 220 words a minute.
- **Publish**: the worker's publish route recomputes `entities.mention_count`, `first_seen_at` and `last_seen_at`
  from published stories after every publish (`syncEntityStats()` in `web/lib/insights.ts`: idempotent, writes only
  rows that changed). The admin's Publish button does not call it yet, so an edition published there is counted at
  the next worker publish; reader pages count published mentions live and never depend on these columns.
- **POST /runs/{id}/outputs**: the worker sends one entry per successful Claude call (curate, Urdu and QA per group)
  right after the editorial passes, before the edition PUT, so the outputs are kept even when delivery fails, and the
  image checks' entries (stage `image`, every outcome, failed checks included) in a second request after the image
  step. It is best effort: a failure is logged and the run goes on. Failed editorial calls have no output and are not sent.

## Authentication
`WORKER_TOKEN` (32+ random bytes, hex). Compared with a constant-time check. Missing or wrong → 401. These routes are excluded from locale routing and are never cached.
