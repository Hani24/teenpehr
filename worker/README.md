# Teen Pehr worker

The Python side of Teen Pehr: it collects articles and posts, has Claude cluster and write
each edition in English and Urdu, checks the result, and publishes through the web app's
worker API. It never touches the database directly (see `docs/API.md`).

Code does the fetching and bookkeeping; Claude only judges. `DRY_RUN=1` (or `--dry-run`) makes
no write at all and leaves `out/<date>-<slot>.json` with everything that would have been sent.

## Setup

```bash
cd worker
uv sync                      # Python 3.12 venv in .venv (uv picks it from .python-version)
cp ../.env.example .env      # then set WORKER_TOKEN (same as web/.env.local) and ANTHROPIC_API_KEY
uv run teenpehr health       # the web app must be running on SITE_URL
```

Environment (all optional except `SITE_URL`, `WORKER_TOKEN`): `ANTHROPIC_API_KEY`,
`NEWS_MODEL_CURATE` / `NEWS_MODEL_URDU` / `NEWS_MODEL_QA`, `BUDGET_CURATE_USD` /
`BUDGET_URDU_USD` / `BUDGET_QA_USD` (per Claude call), `DAILY_BUDGET_USD` (skips a run past it),
`GERMANY_PROXY` (`socks5h://127.0.0.1:1080`, used for sources whose route is `germany` and as
the fallback when a host is unreachable), `LOOKBACK_HOURS` (override the computed window),
`TWITTERAPI_IO_KEY` (paid fallback for silent X handles), `NTFY_TOPIC`, `NTFY_ON_SUCCESS`,
`OUT_DIR`, `TZ`.

## Commands

| Command | What it does |
| --- | --- |
| `teenpehr edition [--slot subh\|dopahar\|shaam] [--date YYYY-MM-DD] [--groups a,b] [--dry-run]` | One edition run. Without `--slot`, the latest slot that has passed (yesterday's shaam before 07:00). A run more than 2 h after its slot is a backfill: it still publishes but sends no notifications. |
| `teenpehr collect-x [--dry-run]` | Read every group's public X Lists via the syndication endpoint (5 s spacing) and store the posts. Runs every 30 minutes. |
| `teenpehr check-sources [--group slug]` or `--url URL [--url URL]` | Fetch feeds once and print a table (route used, HTTP status, items, ms, newest item age). No writes. |
| `teenpehr check-x <list_id>` | Fetch one X List and summarise it. |
| `teenpehr resubmit out/failed-<run_id>.json [--no-publish]` | PUT (and publish) an edition whose delivery failed, without calling Claude again. The file is renamed to `resubmitted-…` on success. |
| `teenpehr health` | Check the API is reachable with this token. |

## How an edition run works

1. `GET /config`; pick the slot; window = previous slot minus 2 h overlap.
2. Fetch every active `rss`, `gnews` and `youtube` source in a thread pool, one request per
   host at a time, through curl_cffi with a Chrome fingerprint and conditional requests. A
   direct fetch that fails twice with a DNS or connection error is retried through Germany.
   Google News titles lose their outlet suffix and links are decoded to the publisher URL.
   Feed blurbs under 200 characters get the article body (trafilatura, capped, at most
   `ARTICLE_FETCH_LIMIT` per run).
3. Dedupe by canonical URL and title, cap per source, `POST /items` (learn which are new),
   `GET /posts` per group.
4. Per group, in parallel: **curate** (Claude, `prompts/curate.md`, structured output), with
   every `ref`/`refs`/`posts`/angle checked against the input; a story citing an unknown item
   is dropped, and a group whose curation fails falls back to raw headlines. Then **Urdu**
   (`prompts/urdu.md`, glossary spellings mandatory, output normalised to Urdu code points)
   and **QA** (`prompts/qa.md`, verified or flagged per story).
5. `PUT /editions/{date}/{slot}` then `POST /editions/{date}/{slot}/publish`; new glossary
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

Token accounting: every Claude call logs `tokens in=… (uncached=… cache_read=… cache_write=…)
out=…` and the run logs one `tokens per pass` line (curate, urdu, qa, total). A call's tokens
are summed over that query's API turns, so a cached prompt read again on a second turn counts
again; that is what Anthropic bills. The run total is a plain sum of the calls.

## systemd

`infra/systemd/news-worker.timer` runs `uv run teenpehr edition` from this directory three
times a day (07:00, 13:00, 19:30 Asia/Karachi); `x-collector.timer` runs
`uv run teenpehr collect-x` every 30 minutes; `germany-proxy.service` keeps the SOCKS proxy
up. See `infra/README.md`.

## Development

```bash
uv run pytest            # 37 tests, no network, no Claude
uv run ruff check src tests && uv run ruff format src tests
```

Tests use `FakeLLM`, `respx` mocks for the API and a saved X List page
(`tests/fixtures/x_list_84839422.html`, X's own "Official Twitter Accounts" list).
