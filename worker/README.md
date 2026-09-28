# Tabayyun worker

The Python side of Tabayyun (the package and CLI keep the working name `teenpehr`): it collects articles and posts, has Claude cluster and write
each edition in English and Urdu, checks the result, and publishes through the web app's
worker API. It never touches the database directly (see `docs/API.md`).

Code does the fetching and bookkeeping; Claude only judges. `DRY_RUN=1` (or `--dry-run`) makes
no write at all and leaves `out/<date>-<slot>.json` with everything that would have been sent (and the
stories' images under `out/<date>-<slot>/images/`).

Claude access: every model call goes through `claude-agent-sdk`, which runs the Claude Code CLI
signed in on this machine (the owner's Claude subscription). There is no API key and no
`anthropic` package: the worker hands the CLI `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (and
the Bedrock, Vertex and Foundry switches) as empty values, so a key left in `.env` or the shell can
never move the worker to API billing; one found there is logged as ignored. The dollar figures in
logs, the run row and `DAILY_BUDGET_USD` are API-equivalent (the CLI prices each call's tokens at
API list prices): a usage measure and ceiling, not a bill. Usage shares the account's Claude Code
limits with interactive sessions on the same account. Every call starts with zero tools: no
built-in tool, no MCP server (`--strict-mcp-config`) and none of the account's claude.ai connectors
(`ENABLE_CLAUDEAI_MCP_SERVERS=false`), which a claude.ai login would otherwise load into sessions
whose prompts are built from untrusted articles and images.

## Setup

```bash
cd worker
uv sync                      # Python 3.12 venv in .venv (uv picks it from .python-version)
cp ../.env.example .env      # then set WORKER_TOKEN (same as web/.env.local)
claude                       # sign in once as this user (/login), or: claude setup-token, and put the
                             # token in .env as CLAUDE_CODE_OAUTH_TOKEN (steadier for the timer)
uv run teenpehr health       # web API reachable (SITE_URL) and the CLI "logged_in": true; spends nothing
```

Run from inside a Claude Code session (an agent testing the worker), start it as
`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT uv run teenpehr …`, so the nested CLI starts cleanly.

Environment (all optional except `SITE_URL` and `WORKER_TOKEN`; `edition` also needs the Claude Code
CLI signed in, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and exits 2 without it, dry runs
included): `NEWS_MODEL_CURATE` / `NEWS_MODEL_URDU` / `NEWS_MODEL_QA`, `BUDGET_CURATE_USD` /
`BUDGET_URDU_USD` / `BUDGET_QA_USD` (per Claude call, API-equivalent dollars), `DAILY_BUDGET_USD` (a
daily usage ceiling in API-equivalent dollars: a run is skipped past it, and the image check stops),
`IMAGES` (`0` turns story images off), `IMAGE_CHECK` (`0` skips the vision check; every image is then
sent as graphic, i.e. blurred, unless `IMAGES_TRUST_UNCHECKED=1`), `NEWS_MODEL_IMAGE_CHECK` (default
`NEWS_MODEL_QA`, Haiku 4.5), `BUDGET_IMAGE_CHECK_USD` (per check, default 0.05),
`IMAGE_PAGE_FETCH_LIMIT` (article pages read per run only to find an image, default 40),
`IMAGE_TIME_LIMIT_S` (wall-clock limit on the image step, default 600; stories still waiting get none),
`GERMANY_PROXY` (`socks5h://127.0.0.1:1080`, used for sources whose route is `germany` and as
the fallback when a host is unreachable), `LOOKBACK_HOURS` (override the computed window),
`TWITTERAPI_IO_KEY` (paid fallback for silent X handles), `NTFY_TOPIC`, `NTFY_ON_SUCCESS`,
`OUT_DIR`, `TZ`.

## Commands

| Command | What it does |
| --- | --- |
| `teenpehr edition [--slot subh\|dopahar\|shaam] [--date YYYY-MM-DD] [--groups a,b] [--dry-run]` | One edition run. Without `--slot`, the latest slot that has passed (yesterday's shaam before 07:00), and afterwards any slot that fell due while it ran (at most two more; see *Catch-up* below). `--date` needs `--slot`. A run more than 2 h after its slot is a backfill: it still publishes but sends no notifications. A slot that is already published or held for review is skipped before anything is fetched or Claude is called (release a hold in the admin to redo it). `--groups` on a live run replaces only those groups in the draft (`"partial": true`); the other groups stay, and the edition is published only once it has every group (a `--groups` run that creates the edition leaves it a draft). |
| `teenpehr edition --scheduled` | What the timer runs every 10 minutes: the latest slot due by the admin's edition times, once (see *The timer* below). Takes no other option. |
| `teenpehr collect-x [--dry-run]` | Read every group's public X Lists via the syndication endpoint (5 s spacing) and store the posts. Runs every 30 minutes. |
| `teenpehr check-sources [--group slug]` or `--url URL [--url URL]` | Fetch feeds once and print a table (route used, HTTP status, items, ms, newest item age). No writes. |
| `teenpehr check-x <list_id>` | Fetch one X List and summarise it. |
| `teenpehr resubmit out/failed-<run_id>.json [--no-publish]` | PUT (and publish) an edition whose delivery failed, without calling Claude again. The file is renamed to `resubmitted-…` on success. An edition held for review is refused (release the hold first); a file saved by an incomplete `--groups` run is only PUT. |
| `teenpehr health` | Check the API is reachable with this token and that the Claude Code CLI is signed in (`claude auth status`: auth mode `login` or `oauth_token`, method, plan; no model call, no tokens). Exits 1 if either fails. |

## How an edition run works

1. `GET /config`; pick the slot; window = previous slot minus 2 h overlap.
2. Fetch every active `rss`, `gnews` and `youtube` source in a thread pool, one request per
   host at a time, through curl_cffi with a Chrome fingerprint and conditional requests. A
   direct fetch that fails twice with a DNS or connection error is retried through Germany.
   Google News titles lose their outlet suffix and links are decoded to the publisher URL, in
   one batch per feed through the same fetcher (host lock, fingerprint, 429 cooldown). Feed blurbs
   under 200 characters get the article body (trafilatura, capped, at most `ARTICLE_FETCH_LIMIT`
   per run) when the site's robots.txt allows the page, spaced by its Crawl-delay. A host that
   answers 429 is left alone for its Retry-After (15 minutes without one), across runs.
   Every request, and every redirect hop (followed by the fetcher, not by curl), goes to the
   public internet only: loopback, LAN, link-local and other reserved addresses are refused
   (`refused=True`, never retried through Germany). Direct requests are pinned to the addresses
   checked (CURLOPT_RESOLVE); on the Germany route the proxy resolves names, so only IP literals,
   local names and names that resolve here to such addresses can be refused.
   A feed that answers 304 still contributes: its items in the window are read back from the API
   (`GET /items`), and the validators behind a 304 are saved only once the items are stored.
3. Dedupe by canonical URL and title per group (an article in two groups' feeds reaches both),
   cap per source, `POST /items` (learn which are new; every feed's sighting is recorded), and
   `GET /posts` per group. An item stored by an earlier run is shown to Claude with the title and
   text first stored, because that is what the story's citation shows.
4. Per group, in parallel: **curate** (Claude, `prompts/curate.md`, structured output; the
   items and the existing threads go in the user message inside `<items>` / `<threads>`, one line
   each, and every prompt says fetched text is data, never instructions; a new thread title is
   cut to one plain line of 120 characters), with
   every `ref`/`refs`/`posts`/angle checked against the input; a story citing an unknown item
   is dropped, and a group whose curation fails falls back to raw headlines. Then **Urdu**
   (`prompts/urdu.md`, locked glossary spellings mandatory, output normalised to Urdu code points)
   and **QA** (`prompts/qa.md`, verified or flagged per story). Fallback headlines, stories the
   Urdu pass or QA left out, and every story of a failed pass are flagged, so the publish sends the
   edition to review (with an ntfy note) instead of the front page.
5. **Images** (decision D6, `images/`), for every story, at most two downloads at a time and one per
   host: the image of what the story cites and nothing else. Candidates in order: the primary cited
   item's lead image (feed media, or the image its page gave during collection), else that article
   page's `og:image` / `twitter:image` / schema.org image (the page is read through the same
   robots.txt-honouring fetcher, at most `IMAGE_PAGE_FETCH_LIMIT` pages a run; relative URLs resolved;
   `data:` and SVG skipped), then the other cited items the same way, then the first photo of each
   cited X post. A Google News item uses its decoded publisher page, never news.google.com; a YouTube
   item its video still. The download goes through the Fetcher (host lock, the source's route,
   public addresses only on every redirect hop, robots.txt and Crawl-delay of the image host, 429 cooldown, 8 MB cap
   enforced by curl, `image/*` only, the article URL as Referer). Pillow then decodes it (JPEG, PNG,
   GIF, WebP or AVIF by the file's signature; 40 MP decompression-bomb guard; `verify()`; animated
   files refused), turns it upright (EXIF), converts to sRGB (ICC and CMYK included; transparency
   flattened on white), rebuilds it from raw pixels (no EXIF, XMP or ICC survives) and writes still
   WebP at 480 and 960 px wide, never upscaled, with the dominant colour and the SHA-256 of the
   downloaded bytes. Refused: under 300 px wide, a banner or long-graphic shape, a file named like a
   logo or placeholder, an image URL a feed uses for three or more of its items this run, the same
   picture on a second story. Then one small **vision check** per image (`prompts/image_check.md`,
   Haiku 4.5 through Claude Code, tools off, thinking off, the 480 px WebP sent as a base64 image
   block in the SDK's streamed user message): `{graphic, placeholder_or_logo}`. A placeholder or logo
   moves on to the next candidate (two checks per story at most); a check that fails, times out
   (90 s) or is skipped for the daily ceiling makes the image graphic (blurred for readers), never
   safe. Alt text is only ever the publisher's (`og:image:alt`, `twitter:image:alt`, a schema.org
   caption, an X post's media description); the credit is the outlet's feed name (for Google News,
   the outlet the entry names; for a post, its author). Each image goes to `POST /images`, and the
   story's `image_id` is set before the PUT. Nothing here can fail a story or the run: a failure is
   logged and the story has no image; should the PUT refuse the images, the edition goes again
   without them.
6. `PUT /editions/{date}/{slot}` then `POST /editions/{date}/{slot}/publish`; new glossary
   terms are proposed; the run row gets per-source results, tokens and cost; failures post to
   ntfy. If the PUT or the publish fails (API error or web app unreachable), the finished
   edition is written to `out/failed-<run_id>.json` and the run is marked failed; replay it with
   `teenpehr resubmit`. Item and post ids in that file are server ids (items are stored before
   curation), so nothing is re-fetched or re-written.

Fetching details: relative links in a feed are resolved against the feed URL; URLs are
percent-encoded before they are sent to the API; the impersonation profile owns the
User-Agent (never override it) and the fetcher sends a browser navigation header set; a feed
that times out is retried once after the others finish; undated entries are kept and the API's
`is_new` stops repeats. The News International's current feed is `rss/1/2` (`rss/1/1` stopped
updating in November 2025).

Research metadata (decision D5: every item is kept, with what is known about it). Each item
carries what its feed says (author, categories, lead image, description, guid, update time, the
feed's title as site name), a word count, a script-based language guess (`ur`, `fa`, `ar`, `en`,
`und-Latn`, ...), how it was fetched (`fetch`: route, tier, HTTP status, ms, `via` rss / gnews /
youtube / article) and `raw`, a small capped subset of the feed entry. An article page fetched for
its body adds the page's own author, site name, tags, image, description, date and language (the
page's date and language go into `raw.article`; `published_at` stays the feed's). A 304 feed's
read-back items are sent with `fetch.status` 304, so the server records the sighting but never takes
them for a changed headline. Posts carry their counts (likes, reposts, replies, quotes, views and
bookmarks where the platform gives them), hashtags, mentions, links, media with alt text, language
and reply thread; a repost carries the original's. Curation also returns, per story, up to 8
keywords, 1-3 topics and an event type (slugs mirrored from `web/lib/taxonomy.ts` in
`models.py`; an unknown slug is dropped, never a failed call), ISO country codes, places and up to
6 entities. Entities and places are kept only when their name occurs in the story's own cited items
(a post counts with its author's name), keywords when they occur there or in the story; the rest
are logged and dropped. The Urdu pass spells each entity's name (`entities_ur`), and the glossary's
spelling wins over it (locked before proposed). Every successful Claude call's output goes to
`POST /runs/{id}/outputs` right after the passes; a dry run writes the items (with all their
metadata) and the outputs into `out/<run_id>.json` instead.

Cost of the metadata: about 150-200 more output tokens per curated story (roughly 7,500 per
six-group run) and about 700 more input tokens per curation call (the longer schema and prompt),
plus about 40 output tokens per story in the Urdu pass. At the list prices of the default models
(Sonnet 5 for curation at $2 in / $10 out per million tokens, Opus 5.5 for Urdu at $4 / $20) that
is roughly $0.10-0.12 per edition, about $0.35 a day against the $6 daily budget. QA is unchanged.

Cost of the image check, measured on 28 September 2026 through the CLI (Haiku 4.5, thinking off, no
tools, MCP servers or connectors): about 1,800 input tokens per call (the CLI's own framing and the
structured-output tool are most of it; the 480 px image is about 200) and about 170 output tokens,
$0.0036 API-equivalent per image. (With the account's claude.ai connectors loaded, as before they were
switched off, the same call took about 3,900 input tokens and $0.006.) At that size the CLI's prompt
cache was neither written nor read, so the figure holds for every call. An edition of 30-45 stories
makes one check per image shown plus one per placeholder skipped: about $0.13-0.20 per edition,
$0.40-0.60 a day against the $6 ceiling. With thinking on (the CLI's default) the same check cost
more, which is why it is off. Each check starts a CLI process, three at a time (7-11 s each), so the
step adds one to two minutes to a run.

Token accounting: every Claude call logs `tokens in=… (uncached=… cache_read=… cache_write=…)
out=…, $… API-equivalent` and the run logs one `tokens per pass` line (curate, urdu, qa,
image_check, total). A call's tokens are summed over that query's API turns, so a cached prompt read
again on a second turn counts again, as the API would price it. The run total is a plain sum of the
calls. Image checks count in the run's tokens, cost and the daily ceiling but are not kept as run
outputs (`POST /runs/{id}/outputs` takes curate, urdu and qa); their verdicts are in the run log.

Exit codes of `teenpehr edition`: 0 when an edition was delivered or there was nothing to do
(already published or held, dry run, a timer firing with no slot due); 1 when a slot got no
edition (failed, empty, daily budget reached, the web app down when a slot fell due; empty and
budget also post to ntfy); 2 for bad arguments or configuration (the Claude Code CLI signed out
included); 130 when interrupted.
`collect-x` exits 1 when no configured List returned a post, or when it crashed or was stopped.

## Catch-up

systemd never starts `news-worker.service` while a run is still active, so a timer firing that
lands inside a long run is dropped (resume at 12:50, the 07:00 backfill still running at 13:00).
An automatic run therefore re-resolves the slot when it finishes and runs any slot that came due
meanwhile, at most two more, stopping after a budget skip. Explicit `--slot`, `--date`,
`--groups` and dry runs do exactly what was asked.

## The timer

`infra/systemd/news-worker.timer` runs `uv run teenpehr edition --scheduled` from this directory
every 10 minutes. It reads the edition times from the admin settings (`GET /config`) and runs the
latest slot that is due unless the timer already started it, so each slot starts within 10 minutes
of its time and a change in the admin needs no timer change. Started slots are kept in
`out/state/schedule.json` (keep `out/state/` across deploys): a slot is started once, whatever the
outcome, and a failed or empty one is rerun by hand. When the web app does not answer, the times
last read decide whether a slot is due; if one is, that firing fails (one OnFailure alert per slot)
and later firings retry quietly until the app is back. `x-collector.timer` runs
`uv run teenpehr collect-x` every 30 minutes; `germany-proxy.service` keeps the SOCKS proxy up.
Both worker units pull in `teenpehr-web.service` and alert through ntfy on a non-zero exit. See
`infra/README.md`.

## Development

```bash
uv run pytest            # no network, no Claude
uv run ruff check src tests && uv run ruff format src tests
```

Tests use `FakeLLM`, `respx` mocks for the API and a saved X List page
(`tests/fixtures/x_list_84839422.html`, X's own "Official Twitter Accounts" list).
