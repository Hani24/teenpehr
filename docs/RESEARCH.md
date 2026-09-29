<!-- Exported from the Claude Doc "Bilingual News Digest Plan" (Research tab) on 2026-09-23. Live copy: https://claude.ai/code/artifact/7e485eed-9c06-4459-802f-ad4361224b21 -->

# Research

Reference tables behind the plan: fetching libraries, X/Twitter options, Urdu fonts, worker automation details, the seed source pack, the coverage audit of 29 September 2026 and product benchmarks. Each fills in as its research lands.

## Anti-bot fetching libraries

Release dates and stars were read from GitHub and PyPI on 23 September 2026; "passes Cloudflare" is judged from independent benchmarks, not READMEs. Y\* means it passes with a clean residential IP and a persistent profile. No open-source tool passes hard DataDome, HUMAN, Kasada or Akamai deployments reliably.

| Tool | Type | Language | License | Last release | Cloudflare | DataDome / HUMAN | Cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | Fetcher (curl\_cffi), StealthyFetcher (Patchright), adaptive parser | Python | BSD-3 | 0.4.15, 23 Aug 2026 | Y (`solve_cloudflare=True`) | Partial | Free | Primary pick for tiers 1 and 2 |
| [curl\_cffi](https://github.com/lexiforest/curl_cffi) | HTTP client with browser TLS and HTTP/2 fingerprints | Python | MIT | 0.16.3, 2 Sep 2026 | Y where no JS challenge (26 of 28) | N | Free | Tier 1 workhorse |
| [primp](https://pypi.org/project/primp/) | Rust HTTP client, Chrome 144 to 153 profiles | Python | MIT | 2.0.1, 13 Sep 2026 | As curl\_cffi | N | Free | Faster alternative |
| [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | Patched Playwright, Chromium only | Python, Node | Apache-2.0 | 1.63.0, 20 Sep 2026 | Y\* (25 of 28) | Partial (about 69 percent) | Free | Engine inside Scrapling; the Node option |
| [zendriver](https://github.com/cdpdriver/zendriver) | Direct CDP driver, nodriver fork | Python | AGPL-3.0 | 0.16.0, 16 Aug 2026 | Y\* (best: 0 blocked of 31) | Untested | Free | Tier 2 fallback |
| [nodriver](https://github.com/ultrafunkamsterdam/nodriver) | Direct CDP driver | Python | AGPL-3.0 | 0.50.3, 13 May 2026, idle since | Y\* | Untested | Free | Use zendriver instead |
| [SeleniumBase](https://github.com/seleniumbase/SeleniumBase) UC and CDP Mode | Selenium plus pure-CDP stealth | Python | MIT | 4.54.11, 22 Sep 2026 | Y, auto-clicks Turnstile | Partial | Free | Most battle-tested Turnstile clicker; needs Xvfb |
| [Camoufox](https://github.com/daijro/camoufox) | Firefox anti-detect fork, Playwright API | Python | MPL-2.0 | beta.30, 1 Sep 2026 after a year's gap | Y\* | Partial (67 to 74 percent) | Free | Try on DataDome sites only |
| [Botasaurus](https://github.com/omkarcloud/botasaurus) | Framework with CDP driver | Python | MIT | 4.0.101, 10 Aug 2026 | Claims | Claims | Free | No independent 2026 benchmark |
| [Crawlee](https://crawlee.dev/python/docs/guides/avoid-blocking) | Crawler framework with fingerprint generation | JS, Python | Apache-2.0 | 3.18.1 and 1.10.2, Sep 2026 | Y\* for JS challenge, no Turnstile solver | Partial | Free | Overkill for 50 URLs |
| [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) | Playwright patch set | Node, Python | Unlisted | 1.0.19, May 2025 | N (tied vanilla) | N | Free | Skip |
| [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | Solver proxy on undetected-chromedriver | Python | MIT | 3.5.2, 12 Sep 2026 | N for managed challenge | N | Free | Obsolete |
| [Byparr](https://github.com/ThePhaseless/Byparr) | FlareSolverr drop-in on patched Firefox | Python | GPL-3.0 | 3.0.4, 18 Aug 2026 | Y\* | N | Free | Cookie-harvesting sidecar only |
| tls-client, hrequests, cloudscraper, rnet | HTTP clients | Python | Mixed | 2024 to Aug 2025 |  |  | Free | Dead or stale, skip |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) `--extension` | MCP into real Chrome | Node | Apache-2.0 | 0.0.82, 18 Sep 2026 | Usually, real profile | Usually | Free | Interactive only |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP via CDP into running Chrome | Node | Apache-2.0 | 1.10.1, 23 Sep 2026 | Usually | Usually | Free | CDP attach is itself detectable |
| [Claude in Chrome](https://code.claude.com/docs/en/chrome) | Anthropic extension |  | Proprietary | Extension 1.0.36 or later | Pauses on CAPTCHA by design | Same | Plan included | Fingerprintable ([CHEQ, Feb 2026](https://cheq.ai/blog/the-cyborg-session-reversing-detecting-claude-ai-agent-chrome-extension/)); not a bypass |
| Browser-use, Stagehand | LLM browser agents | Python, TS | MIT | Very active | Depends on browser | Same | Tokens | Wrong tool for reading 50 articles |

Hosted services, prices read on 23 September 2026:

| Service | Passes Cloudflare | Price | Notes |
| --- | --- | --- | --- |
| [Jina Reader](https://jina.ai/reader/) | No, does not circumvent anti-bot | 20 requests a minute keyless; 10M free tokens per key | Try first for markdown; expect 403 on Cloudflare sites |
| [Firecrawl](https://www.firecrawl.dev/pricing) | Yes for most, auto proxy escalation | 1,000 free credits a month; Hobby 19 dollars for 5,000; Standard 99 dollars for 100,000 | Self-hosted (AGPL) has no anti-bot layer |
| [Zyte API](https://www.zyte.com/pricing/) | Yes, top of 2026 benchmarks | 5 dollars free; 0.13 to 1.27 dollars per thousand HTTP, 1.01 to 16.08 per thousand browser; pay on success | Best pay-per-hard-page |
| [ScrapingBee](https://www.scrapingbee.com/#pricing) | Only with stealth proxy (75 credits) | 1,000 free; Hobby 19 dollars for 75,000 credits | About 1,000 hard pages per Hobby plan |
| ScraperAPI | With ultra-premium plus render (75 credits) | 1,000 free a month; Hobby 49 dollars for 100,000 | Similar economics |
| [Apify](https://use-apify.com/docs/what-is-apify/is-apify-legal) | Actor dependent | 5 dollars free a month; Starter 29 dollars; residential 8 dollars per GB | Good for social-profile actors |
| Browserbase, [Steel](https://github.com/steel-dev/steel-browser), Hyperbrowser | Stealth on paid tiers | Browserbase Dev 20 dollars for 100 hours; Steel usage-based and self-hostable; Hyperbrowser 30 dollars for 30,000 credits | Agent infrastructure, not fetchers |
| Turnstile solvers |  | 2Captcha 1.45, CapSolver 1.20, CapMonster 1.30 dollars per thousand; NopeCHA 4.99 a month | Rarely needed for reading |
| Residential proxies |  | Bright Data 8 dollars per GB list; Oxylabs 6 to 2.50; Decodo 3.75 to 2.75; IPRoyal about 1.75 non-expiring | Not needed from a home ISP at this volume |

Benchmark and detection references: [Patchright, nodriver and curl\_cffi benchmark, May 2026](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/), [Is Camoufox still effective](https://www.scraping.club/p/is-camoufox-still-effective-scraping), [HTTP/2 fingerprinting](https://scrapfly.io/blog/posts/http2-http3-fingerprinting-guide), [headless detection](https://cside.com/blog/headless-browser-detection), [Cloudflare's agent defaults](https://blog.cloudflare.com/content-independence-day-ai-options/), [Google News link decoding](https://github.com/mohamidi74/gnews-decoder).

## X/Twitter reading options

Every row was probed live from this laptop on 23 September 2026; costs assume 50 to 200 handles polled three times a day.

| Method | Cost | Account needed | Works now | Ban or block risk | Notes |
| --- | --- | --- | --- | --- | --- |
| [Official API v2](https://docs.x.com/x-api/getting-started/pricing), pay-per-use | 0.005 dollars per post read; 60 to 240 dollars a month with `since_id`, up to 1,800 naive | Developer account and card | Yes | None | Only sanctioned read; free tier gone; Basic migrated 1 June 2026, Pro after 1 September 2026 |
| Syndication list endpoint `srv/timeline-list/list-id/<id>` | 0 | One account to create a public List | Yes, verified: 97 entries, newest 11:26 UTC that day, 14 authors | Low; could vanish any day | About 100 latest posts, no cursor, separate rate bucket |
| Syndication profile endpoint `srv/timeline-profile/screen-name/<h>` | 0 | No | Partly: 13 of 28 handles fresh, 12 stale snapshots, 1 empty | Low; about 50 requests per 15 minutes per IP, lockout over 6 minutes | Freshness lottery |
| [twscrape](https://github.com/vladkens/twscrape) 0.20.1, [twifork](https://github.com/PawiX25/twifork), [bird](https://www.npmjs.com/package/@steipete/bird) 0.8.0 | 0 | Yes, cookies from a throwaway account | Yes (August and September 2026 releases) | Medium to high on that account; breaks on front-end changes | Best DIY fallback; bird's source is now private |
| Nitter, XCancel, their RSS | 0 | No | No: cease-and-desist 24 August, repository archived 11 September, XCancel returns HTTP 451 since 15 September 2026 |  | Remaining instances sit behind Anubis or Cloudflare walls |
| [twitterapi.io](https://twitterapi.io/) | 0.15 dollars per thousand posts; about 14 to 54 dollars a month | No | Yes | None | 20 posts per call; cheapest hosted |
| [SocialData](https://docs.socialdata.tools/getting-started/pricing/) | 0.0002 dollars per post; about 18 to 72 dollars a month | No | Yes | None | Failed calls free, prepaid |
| [Apify actors](https://apify.com/apidojo/tweet-scraper) | 0.15 to 0.40 dollars per thousand, 50-post minimum per query | Apify account | Yes | None | About 360 dollars a month for per-handle polling; only sensible with batched `from:` searches |
| Bright Data | 1.50 dollars per thousand records | Yes | Yes | None | Overkill; pricing unverified from here |
| ScrapingDog, RapidAPI listings | 40 dollars a month and up |  | Profile metadata only, or outage-prone |  | Skip |
| Playwright or Patchright with a logged-in persistent profile | 0, plus 8 dollars Premium | Yes | Yes | Medium to high: 1,000 post views a day unverified, Arkose challenges, ban waves | 30 to 60 profile loads an hour at most; open a List page instead |
| Claude in Chrome | Claude tokens | Paid plan and visible Chrome | Yes, GA since 26 August 2026 | As above | Fine for one List page, wasteful for 200 profiles |
| [Bluesky public API](https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed) | 0 | No | Yes | None | Present: NDTV, Scroll, The Wire, Al Jazeera, TOLOnews, Geo News Urdu, Ravish Kumar, Mehdi Hasan; Hamid Mir last posted June 2026; Omar Abdullah dormant |
| Telegram `t.me/s/<channel>` | 0 | No | Yes, but TCP to t.me timed out from this laptop (ISP block) | Low | Needs a VPS; few Pakistani or Indian journalists run channels |
| YouTube channel RSS | 0 | No | Yes, tested | None | Anchors turned YouTubers |
| Threads | API review | Yes | Effectively no |  | Skip |

X's terms: scraping without written consent is prohibited; liquidated damages 15,000 dollars per million posts in 24 hours; the 9 October 2026 terms add liability for facilitators ([x.com/en/tos](https://x.com/en/tos)). Case law: hiQ v LinkedIn (public data outside the CFAA, but hiQ lost on contract for using fake logged-in accounts), X v Bright Data dismissed May 2024 and settled June 2025 with no appellate precedent, Meta v Bright Data (logged-out scraping did not breach terms). Coverage of the shutdown: [TechCrunch, 15 September 2026](https://techcrunch.com/2026/09/15/nitter-and-xcancel-are-dead-again-after-xs-latest-legal-actions/), [The Register](https://www.theregister.com/personal-tech/2026/09/07/nitter-lives-to-proxy-another-day-after-taking-legal-advice/). Pay-per-use launch: [MediaNama](https://www.medianama.com/2026/02/223-x-developer-api-pricing-pay-per-use-model/).

## Urdu web fonts

Every font was downloaded and inspected with fontTools on 23 September 2026 (character map, `locl` language systems, vertical metrics, glyph extents, real woff2 sizes); news-site stacks were read from the live CSS the same day.

| Font | Style | Licence | woff2 | Weights | Urdu letters and `locl` URD | Best use | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Noto Naskh Arabic](https://github.com/google/fonts/tree/main/ofl) 2.021 | Naskh | OFL | 91 KB variable | 400 to 700 | Full, yes | Body (Buzurg default), UI | Primary body |
| [Noto Nastaliq Urdu](https://github.com/notofonts/nastaliq/releases) v4.000, self-hosted | Nastaliq | OFL | 112 KB Regular, 156 KB variable | 400 to 700 | Full, yes | Headlines, body in Classic and Night | Primary Nastaliq; Google Fonts still serves 3.009 at 233 KB ([PR closed unmerged](https://github.com/google/fonts/pull/7950)) |
| [Gulzar](https://gulzarfont.org/) 1.000 | Nastaliq, contextual engine | OFL | 203 KB | 400 only; [repository archived 19 April 2026](https://github.com/googlefonts/Gulzar) | Full, yes | Literary body, headlines | Good, single weight, no kashida |
| [Mehr Nastaliq Web](https://mehrtype.com/product/mehr-nastaliq-web/) 2.00 | Nastaliq, Lahori, compact | CC BY-SA 4.0 | 53 KB | 400 | Full, no language system | Body where vertical space matters | Good; share-alike complicates subsetting; used by Rekhta |
| [Hussaini Nastaleeq](https://github.com/aliftype/hussaini-nastaleeq) 0.04 | Nastaliq, Nafees fork | CRULP MIT-style | 117 KB | 400 | Full | Headlines | OK; broken hhea metrics, set line height 2.2 or more by hand; used by VOA Urdu |
| [Nafees Nastaleeq](https://www.cle.org.pk/software/localization/Fonts/nafeesNastaleeq.html) 1.02 | Nastaliq | CRULP MIT-style | 139 KB | 400 | Full | Legacy | Superseded by Hussaini; used by UrduPoint |
| Nafees Web Naskh 1.2 | Naskh | CRULP MIT-style | 60 KB | 400 | Full, no Arabic-Indic digits | Legacy | Superseded by Noto Naskh; used by Geo, Express, Dawn News, Aaj |
| Jameel Noori Nastaleeq, with Kasheeda | Nastaliq | None; Monotype-derived shapes | 10.8 MB TTF | 400 | Full |  | Do not embed in a product |
| [Awami Nastaliq](https://software.sil.org/awami/) 3.400 | Nastaliq | OFL |  | 400, 700 | Full |  | Graphite only: renders in Firefox, LibreOffice and XeTeX, fallback everywhere else |
| Alvi, Faiz Lahori, Pak Nastaleeq | Nastaliq | Non-commercial or no licence text |  | 400 | Full |  | Avoid |
| [Vazirmatn](https://github.com/rastikerdar/vazirmatn) 33 | Sans | OFL | 45 KB variable | 100 to 900 | Full, yes | UI, small text | Primary UI |
| [IBM Plex Sans Arabic](https://fonts.google.com/specimen/IBM+Plex+Sans+Arabic) 1.101 | Sans | OFL | 41 to 43 KB per weight | 100 to 700 static | Full, yes | UI alternative | Good |
| Noto Sans Arabic 2.012 | Sans | OFL | 162 KB | 100 to 900 plus width | Full, yes | UI alternative | Heavy, line height 2.11 |
| Cairo 3.130 | Kufi sans | OFL | 30 KB | 200 to 1000 | Full, yes | Display only | Not for text |
| Readex Pro, Rubik | Sans | OFL |  |  | Missing Urdu letters |  | Unusable for Urdu |
| BBC Reith Qalam 1.310 | Naskh, custom by Dalton Maag | Proprietary | 41 KB per weight | 400, 700 | Full, yes |  | Reference only; body 15 px, line height 24 px |

What the leading Urdu sites load: BBC Urdu, Reith Qalam (Naskh style, `font-display: optional`); DW Urdu, no Urdu webfont; VOA Urdu, Hussaini Nastaleeq; Independent Urdu, Adobe Arabic with Mehr declared; Geo Urdu, Express and Dawn News Urdu, Nafees Web Naskh; Jang, ARY Urdu and Dunya, Noto Naskh Arabic; Rekhta, Mehr Nastaliq; UrduPoint, Nafees Nastaleeq; Hum Sub, Noto Nastaliq Urdu. Nine of fourteen set body text in Naskh.

Open issues on Noto Nastaliq: [line spacing too high](https://github.com/google/fonts/issues/7810), [missing dots before ے](https://github.com/google/fonts/issues/9781), [no Kasheeda variant](https://github.com/notofonts/nastaliq/issues/18). Its typo metrics are 2.50 em while glyph extents span 3.19 em, which is why clamped or fixed-height boxes clip descenders.

CSS starting point (values measured from the font files):

```css
@font-face{font-family:"Noto Naskh Arabic";src:url(/f/NotoNaskhArabic[wght].woff2) format("woff2");
  font-weight:400 700;font-display:swap;unicode-range:U+0600-06FF,U+0750-077F,U+0870-088E,U+08A0-08FF,U+200C-200E,U+2010-2011,U+FB50-FDFF,U+FE70-FEFC}
@font-face{font-family:"Noto Nastaliq Urdu";src:url(/f/NotoNastaliqUrdu-v4[wght].woff2) format("woff2");
  font-weight:400 700;font-display:optional;unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFC}
/* Latin face aligned to the Naskh line box (hhea 1069 / -634) */
@font-face{font-family:"Inter-ur";src:local("Inter");size-adjust:95%;ascent-override:106.9%;descent-override:63.4%;line-gap-override:0%}
/* with a Nastaliq body use ascent-override:190.4%;descent-override:59.6% (Noto Nastaliq 1904 / -596) */
html[lang=ur]{--f-body:"Noto Naskh Arabic","Vazirmatn","Segoe UI","Geeza Pro",serif;
  --f-head:"Noto Nastaliq Urdu","Gulzar","Noto Naskh Arabic",serif;
  --f-ui:"Vazirmatn","IBM Plex Sans Arabic",system-ui;--f-latin:"Inter-ur","Inter",system-ui}
:lang(ur){font-family:var(--f-body);letter-spacing:0!important;hyphens:none;text-align:start;
  overflow-wrap:normal;font-kerning:normal;font-synthesis:none}
:lang(ur) p{font-size:1.5rem;line-height:1.9}
:lang(ur) h1,:lang(ur) h2{font-family:var(--f-head);line-height:2.1;padding-block:.15em;overflow:visible}
:lang(ur).nastaliq p{font-family:var(--f-head);font-size:1.625rem;line-height:2.4}
:lang(ur) nav,:lang(ur) .ui{font-family:var(--f-ui);font-size:1.375rem;line-height:1.8}
bdi,[dir=ltr]{unicode-bidi:isolate}
:lang(ur) .clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;padding-block:.3em}
```

Engineering notes: leave `font-feature-settings` at defaults (`rlig`, `calt`, `curs`, `mark`, `mkmk` and `kern` are on; `font-variant-ligatures: none` breaks Mehr's `calt`); `text-rendering: optimizeLegibility` adds nothing and can slow layout; Tailwind 4.3 has logical utilities (`ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`), so reserve `rtl:` for asymmetric icons and add `@custom-variant ur (&:lang(ur))`; next-intl 4.14.6 has no `getLocaleDirection` export despite some blog posts, so set `dir` in the locale layout from the locale string. Intl behaviour checked in Node 22 with ICU 78.2 and CLDR 48.

Urdu text-to-speech options:

| Provider | Urdu voices | Price per million characters | Notes |
| --- | --- | --- | --- |
| [Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts) | `ur-PK-AsadNeural`, `ur-PK-UzmaNeural`, plus ur-IN | 15 dollars | Only Pakistani-accent Urdu at a major cloud; SSML rate control |
| [Google Cloud TTS](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) | `ur-IN-Chirp3-HD` (30 voices), WaveNet, Standard | 30, 16 and 4 dollars | Most natural, Indian accent, no ur-PK |
| [ElevenLabs](https://elevenlabs.io/docs/overview/models) | Urdu on Eleven v3 and Multilingual v2 only | About 100 dollars | For a cloned anchor voice only |
| Amazon Polly | None |  |  |
| [Meta MMS-TTS](https://huggingface.co/facebook/mms-tts-urd-script_arabic) | `urd-script_arabic` | Free, self-hosted | Robotic; offline fallback only. Piper has no Urdu voice |

Standards and research used: [W3C Arabic layout requirements](https://www.w3.org/TR/alreq/), [WCAG 2.2 text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html), [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html), [NN/g seniors](https://www.nngroup.com/articles/usability-seniors-improvements/), [NN/g on font-size control](https://www.nngroup.com/articles/let-users-control-font-size/), [AARP review](https://danachisnell.com/wp-content/uploads/2025/04/AARP-50Sites.pdf), [Nastaliq preference survey](https://chaoticity.com/a-survey-on-nastaleeq-font-preferences-for-urdu/), [BBC GEL typography](https://bbc.github.io/gel/foundations/typography/), [WeChat Care Mode](https://technode.com/2021/09/29/wechat-rolls-out-care-mode-for-chinas-aging-population/). No peer-reviewed screen legibility study of Nastaliq versus Naskh exists; the Buzurg default is inferred from metrics, industry practice and Latin-script senior research.

## Claude Code automation details

Verified against the live docs on 23 September 2026: Claude Code 2.1.280, Python `claude-agent-sdk` 0.2.158, TypeScript `@anthropic-ai/claude-agent-sdk` 0.3.280, Fedora 44, systemd 259.

**Headless CLI facts.** `claude -p` reads the prompt from stdin (10 MB limit); `--output-format json` carries `result`, `session_id`, `total_cost_usd` and `permission_denials`; `--json-schema` yields `structured_output`. Every `-p` run starts in manual permission mode, so pass `--permission-mode dontAsk` plus `--permission-prompts none` (2.1.259 or later) to deny anything that would prompt. `--allowedTools` uses permission-rule syntax such as `Bash(git diff *)` or `mcp__news__*`. `--bare` skips hooks, skills, MCP, CLAUDE.md and memory and is documented as the recommended mode for scripts, but it does not read OAuth credentials, so it needs `ANTHROPIC_API_KEY`. `--max-turns`, `--max-budget-usd`, `--effort`, `--fallback-model`, `--append-system-prompt-file` and `--no-session-persistence` all apply. SIGTERM leaves the turn unfinished with exit 143; SIGINT ends it cleanly. The docs say `bypassPermissions` belongs only inside a container, VM or the sandbox runtime; `dontAsk` with an allowlist is the unattended choice.

**Built-in scheduling that exists now.** `/loop` and `CronCreate` are session-scoped with up to 30 minutes of jitter and a seven-day expiry, restored only on `--resume`. `claude --bg` is a background session, not a scheduler. Routines (`/schedule`) run in Anthropic's cloud on a fresh GitHub clone with a one-hour minimum interval. Desktop scheduled tasks are macOS, Windows, Ubuntu and Debian only. None survives a Fedora reboot locally except your own timer.

**Billing facts.** Anthropic's help article states that as of 15 June 2026 the announced credit changes are paused and the Agent SDK, `claude -p` and third-party apps still draw from the subscription's limits; the same article says teams running shared production automation should use the Claude Platform with an API key. Third-party harnesses were cut off from subscriptions on 4 April 2026 and reinstated on 13 May. `claude setup-token` yields a one-year `CLAUDE_CODE_OAUTH_TOKEN` for scripts on Pro, Max, Team or Enterprise. Prompt cache TTL is one hour on subscription and five minutes on credits or API.

**API list prices, dollars per million tokens (input / output / cache read).** Fable 5.1: 10 / 50 / 0.25. Opus 5.5: 4 / 20 / 0.20. Opus 5: 5 / 25 / 0.50. Sonnet 5: 2 / 10 / 0.20. Haiku 4.5: 1 / 5 / 0.10. Cache writes cost 1.25 times input. Models from 4.7 onward tokenise about 30 percent more tokens than Haiku 4.5.

| Scenario, per run and per month at three runs a day | Haiku 4.5 | Sonnet 5 | Opus 5.5 | Opus 5 | Fable 5.1 |
| --- | --- | --- | --- | --- | --- |
| Agentic 60 minutes: 40 calls, 120k cache write, 2.4M cache read, 150k uncached in, 40k out | 0.74 and 67 | 1.48 and 133 | 2.48 and 223 | 3.70 and 333 | 5.60 and 504 |
| Code-first: 6 calls, 70k cache write, 300k cache read, 20k uncached in, 15k out | 0.21 and 19 | 0.43 and 38 | 0.79 and 71 | 1.06 and 96 | 1.90 and 171 |

**systemd units.** Timer, validated on this machine:

```ini
[Unit]
Description=News worker 3x/day (Asia/Karachi)
[Timer]
OnCalendar=*-*-* 07,13,19:00 Asia/Karachi
Persistent=true
RandomizedDelaySec=120
AccuracySec=1min
[Install]
WantedBy=timers.target
```

Service:

```ini
[Unit]
Description=News worker run
OnFailure=news-alert@%n.service
[Service]
Type=oneshot
WorkingDirectory=%h/dev/news/worker
EnvironmentFile=%h/.config/news-worker/env
Environment=DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_CRON=1 TZ=Asia/Karachi
ExecStart=/usr/bin/systemd-inhibit --what=sleep:idle --who=news-worker --why=edition /usr/bin/flock -n %t/news-worker.lock %h/dev/news/worker/.venv/bin/python news_worker.py
TimeoutStartSec=100min
KillSignal=SIGINT
TimeoutStopSec=90
SyslogIdentifier=news-worker
Nice=5
```

Alert unit `news-alert@.service`:

```ini
[Unit]
Description=Alert on failure of %i
[Service]
Type=oneshot
EnvironmentFile=%h/.config/news-worker/env
ExecStart=/bin/sh -c 'journalctl --user -u %i -n 40 --no-pager | curl -sS -H "Title: %i FAILED on $(hostname)" -H "Priority: high" --data-binary @- https://ntfy.sh/$NTFY_TOPIC'
```

Enable with `loginctl enable-linger $USER`, `systemctl --user daemon-reload`, `systemctl --user enable --now news-worker.timer`. Lid: `/etc/systemd/logind.conf.d/50-lid.conf` with `HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore`, `HandleLidSwitchDocked=ignore`, then `systemctl kill -s HUP systemd-logind`; and `gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'`. For a headed browser, `systemctl --user import-environment WAYLAND_DISPLAY DISPLAY` lets the service use the GNOME session.

**Agent SDK skeleton (Python).**

```python
import asyncio, json, os, sys, datetime as dt
from zoneinfo import ZoneInfo
from pydantic import BaseModel
from claude_agent_sdk import (query, ClaudeAgentOptions, ResultMessage,
                              tool, create_sdk_mcp_server, HookMatcher)
import db, fetchers  # your code: RSS, X, hashes, Postgres

MODEL = os.environ.get("NEWS_MODEL", "claude-sonnet-5")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
SLOT = dt.datetime.now(ZoneInfo("Asia/Karachi")).strftime("%Y-%m-%d-%H")

class Story(BaseModel):
    thread: str | None; ref: int; refs: list[int]; posts: list[int]
    title: str; summary: str; why: str; tag: str; coverage: str
    contested: str; angles: list[dict]

class Curation(BaseModel):
    lead: str; stories: list[Story]

@tool("prior_coverage", "Headlines already published for a thread", {"thread": str})
async def prior_coverage(args):
    return {"content": [{"type": "text", "text": json.dumps(db.prior(args["thread"]))}]}

news = create_sdk_mcp_server(name="news", version="1.0.0", tools=[prior_coverage])

async def audit(inp, tool_use_id, ctx):
    db.log_tool(SLOT, inp.get("tool_name")); return {}

async def curate(group, items):
    opts = ClaudeAgentOptions(
        model=MODEL, setting_sources=[],
        system_prompt={"type": "preset", "preset": "claude_code",
                       "append": open("prompts/curate.md").read()},
        mcp_servers={"news": news},
        allowed_tools=["mcp__news__prior_coverage"],
        disallowed_tools=["WebSearch", "WebFetch", "Bash", "Edit", "Write"],
        permission_mode="dontAsk", max_turns=12, max_budget_usd=1.0,
        output_format={"type": "json_schema", "schema": Curation.model_json_schema()},
        hooks={"PostToolUse": [HookMatcher(hooks=[audit])]},
    )
    prompt = fetchers.render_items(group, items)  # numbered items with perspective labels
    res = None
    async for m in query(prompt=prompt, options=opts):
        if isinstance(m, ResultMessage): res = m
    if not res or res.subtype != "success" or not res.structured_output:
        raise RuntimeError(getattr(res, "subtype", "no_result"))
    out = Curation.model_validate(res.structured_output)
    valid = {it.idx for it in items}
    if any(r not in valid for s in out.stories for r in s.refs):
        raise RuntimeError("story cites an item not in the input")
    return out, res.total_cost_usd

async def main() -> int:
    if db.run_exists(SLOT): return 0
    per_group = fetchers.collect(lookback_h=9)
    results = {g: await curate(g, items) for g, items in per_group.items() if items}
    # then: urdu pass, qa pass, publish via API unless DRY_RUN
    return 0

if __name__ == "__main__": sys.exit(asyncio.run(main()))
```

Structured output is validated against JSON Schema draft-07 and re-prompted on mismatch; treat `subtype == "error_max_structured_output_retries"` and a success with `structured_output` of `None` both as failures.

**MCP notes.** `@playwright/mcp` 0.0.82 supports `--headless --isolated --storage-state` and `--allowed-origins`; `@modelcontextprotocol/server-postgres` is marked no longer supported on npm, so expose narrow typed tools (`prior_coverage`, `publish_edition`) instead of raw SQL. Firecrawl has an MCP server (3.25.3) if the hosted tier is used.

**Examples worth reading.** [ai-digest-cron](https://github.com/ManaalP/ai-digest-cron) (RSS to per-article summaries, story continuation by entity overlap, under a dollar a month), [newsletter-digest](https://github.com/vgrg13/newsletter-digest) (Desktop scheduled task with a sentinel file because missed fires are not retried), [agent-cron](https://github.com/T0UGH/agent-cron) (serial queue, heartbeat protocol, API key only), [schedule-agent](https://github.com/imjohnbo/schedule-agent) (per-run token log and tool audit trail), [claude-tasks](https://github.com/kylemclaren/claude-tasks) (usage thresholds that auto-skip tasks).

**Not verified.** Exact Max plan token amounts (Anthropic does not publish them); the current `mcp-server-fetch` version; the June credit scheme is paused rather than cancelled, so recheck the [help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) before relying on Max for the worker.

Docs used: [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [routines](https://code.claude.com/docs/en/routines), [Desktop on Linux](https://code.claude.com/docs/en/desktop-linux), [Agent SDK Python](https://code.claude.com/docs/en/agent-sdk/python), [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Claude in Chrome](https://code.claude.com/docs/en/chrome).

## Seed source pack

Every feed below was fetched on 23 September 2026 from this laptop unless marked proxy (verified through r.jina.ai because the host is unreachable from Pakistani ISPs). X handles are from public knowledge and were not re-verified. Ship the first table enabled by default; the second lists more verified feeds to add per group; the third is what does not work.

**Unreachable from Pakistan** (DNS not found or TLS reset): thehindu.com, indianexpress.com, timesofindia, scroll.in, thewire.in, thequint.com, thedailystar.net, foreignpolicy.com, presstv.ir, aljazeera.com, longwarjournal.org and t.me. DNS-only blocks that DNS-over-HTTPS fixes: hindustantimes.com, siasat.com, 5pillarsuk.com, the Radio Azadi domains. The rest route through the Hetzner server in Germany over an SSH SOCKS proxy, which also resolves DNS there. Two exceptions stay on Google News queries: Indian Express refuses datacenter IPs, and Al Jazeera returned 403 through a datacenter proxy during this check.

| Group | Outlet | Language | Feed | Notes |
| --- | --- | --- | --- | --- |
| Pakistan | Dawn | en | `dawn.com/feeds/home`, `/feeds/pakistan`, `/feeds/business` | Full text; paper of record; @dawn\_com, @cyalm, @ZarrarKhuhro |
| Pakistan | Dawn News | ur | `dawnnews.tv/feeds/home` | @DawnNews |
| Pakistan | Geo News | en | `geo.tv/rss/1/1` | Header claims ISO-8859-1, body is UTF-8; @geonews\_english, @HamidMirPAK |
| Pakistan | Jang | ur | `jang.com.pk/rss/1/1`, `/rss/1/2`, `/rss/1/3` | 50 items, short summaries, no XML encoding declaration; @AnsarAbbasi\_, @UmarCheema1 |
| Pakistan | Express Tribune | en | `tribune.com.pk/feed/home`, `/feed/pakistan` | @etribune, @Fahdhusain, @KamranYousaf |
| Pakistan | Express Urdu | ur | `express.pk/feed/home` | 105 items; @ExpressNewsPK |
| Pakistan | The News | en | `thenews.com.pk/rss/1/1` | Investigative desk; @thenews\_intl, @MarianaBaabar |
| Pakistan | Business Recorder | en | `brecorder.com/feeds/latest-news`, `/feeds/markets` | Full text; @brecorder, @ShahbazRana |
| Pakistan | ARY Urdu | ur | `urdu.arynews.tv/feed/` | Full text; English `arynews.tv/feed/`; @ARYNEWSOFFICIAL |
| Pakistan | BBC Urdu | ur | `feeds.bbci.co.uk/urdu/rss.xml` | Headline plus one line; @BBCUrdu |
| Pakistan | Independent Urdu | ur | `independenturdu.com/rss.xml` | Full text, about 12,000 characters; @indyurdu |
| Pakistan | APP | en | `app.com.pk/feed/` | State wire; @appcsocialmedia |
| India | The Hindu | en | `thehindu.com/news/national/feeder/default.rss` | Proxy; metered paywall; @the\_hindu, @suhasinih |
| India | Scroll | en | `feeds.feedburner.com/ScrollinArticles.rss` | 100 items; site blocked from Pakistan, feed reachable; @scroll\_in |
| India | The Wire | en | `cms.thewire.in/feed` | @thewire\_in, @svaradarajan, @khanumarfa |
| India | Hindustan Times | en | `hindustantimes.com/feeds/rss/india-news/rssfeed.xml` | Needs DoH from Pakistan; @htTweets |
| Kashmir | Greater Kashmir | en | `greaterkashmir.com/feed` | Full text; @GreaterKashmir |
| Kashmir | Kashmir Observer | en | `kashmirobserver.net/feed/` | Full text; @KashmirObserver |
| India | Siasat | en, ur | `siasat.com/feed/`, `urdu.siasat.com/feed/` | Hyderabad Muslim daily; needs DoH; @TheSiasatDaily |
| Afghanistan | Amu TV | en | `amu.tv/feed/` | Full text; exile, anti-Taliban; @AmuTelevision, @bsarwary |
| Afghanistan | Hasht-e Subh | en | `8am.media/eng/feed/` | Full text; @8am\_media |
| Afghanistan | Afghanistan International | en, fa | `afintl.com/en/feed`, `afintl.com/feed` | Headlines only; @AfIntlEnglish |
| Afghanistan | Khaama Press | en | `khaama.com/feed/` | 100 items, full text, mixed quality; @Khaama |
| Afghanistan | RFE/RL Gandhara | en | `gandhara.rferl.org/api/` | @GandharaRFE |
| Middle East | Al Jazeera English | en | `aljazeera.com/xml/rss/all.xml` | Unverified today (TLS reset, proxy 403); @AJEnglish, @marwanbishara |
| Middle East | Al Jazeera Arabic | ar | `aljazeera.net/rss` | @AJArabic |
| Middle East | Middle East Eye | en | `middleeasteye.net/rss` | @MiddleEastEye, @DavidHearst, @ragipsoylu |
| Middle East | TRT World | en | `trtworld.com/feed/rss.xml` | 100 items; @trtworld |
| Middle East | Anadolu | en | `aa.com.tr/en/rss/default?cat=guncel` (also `politics`, `world`, `middle-east`) | Urdu feed broken; @anadoluagency |
| Middle East | Times of Israel | en | `timesofisrael.com/feed/` | Blocks curl's user agent, fine with a browser one; @TimesofIsrael |
| Middle East | Haaretz | en | `haaretz.com/srv/haaretz-latest-headlines` | Articles paywalled; @haaretzcom, @GideonLevy |
| Middle East | IRNA | en | `en.irna.ir/rss` | Full text, Iranian state; @IrnaEnglish |
| Middle East | Mondoweiss | en | `mondoweiss.net/feed/` | @Mondoweiss |
| Middle East | Electronic Intifada | en | `electronicintifada.net/rss.xml` | @intifada |
| Muslim world | The Daily Star | en | `thedailystar.net/rss.xml` | Proxy; @dailystarnews |
| Muslim world | Dhaka Tribune | en | `dhakatribune.com/feed/` | Trailing slash matters; @DhakaTribune |
| Muslim world | Malay Mail | en | `malaymail.com/feed/rss/malaysia`, `/feed/rss/world` | Full text; @malaymail |
| Muslim world | Eurasianet | en | `eurasianet.org/rss` | @EurasiaNet, @joannalillis |
| Muslim world | Premium Times | en | `premiumtimesng.com/feed` | @PremiumTimesng |
| Muslim world | Radio Dabanga | en | `dabangasudan.org/en/feed` | Full text, Darfur; @DabangaSudan |
| Muslim world | RFA Uyghur | ug | `rfa.org/uyghur/rss` | Fresh on 22 September 2026; @RFA\_Uyghur |
| World | BBC World | en | `feeds.bbci.co.uk/news/world/rss.xml`, `/world/asia/rss.xml`, `/world/middle_east/rss.xml` | @BBCWorld, @secunderkermani |
| World | Guardian | en | `theguardian.com/world/rss`, `/world/pakistan/rss` | Free Open Platform API too; @guardian |
| World | France 24 (AFP) | en | `france24.com/en/asia-pacific/rss`, `/en/middle-east/rss` | @AFP |
| World | Reuters and AP | en | Google News `site:reuters.com`, `site:apnews.com` | Neither has public RSS (Reuters returns 401, AP is Cloudflare-challenged); @MichaelKugelman |
| World | Crisis Group | en | `crisisgroup.org/rss` | @CrisisGroup |

More verified feeds to add per group: Pakistan: The Nation `nation.com.pk/rss/headlines`, Nawa-i-Waqt `nawaiwaqt.com.pk/rss/latest` (titles only), Daily Pakistan `dailypakistan.com.pk/rss/latest` and `en.dailypakistan.com.pk/feed/`, Aaj `aaj.tv/feeds/` (full text), Daily Times `dailytimes.com.pk/feed/`, The Friday Times `thefridaytimes.com/rss/news`, ProPakistani `propakistani.pk/feed/`, DW Urdu `rss.dw.com/xml/rss-urd-all`. India: NDTV `feeds.feedburner.com/ndtvnews-india-news` (headlines only), Times of India `timesofindia.indiatimes.com/rssfeedstopstories.cms` (proxy), ThePrint `theprint.in/feed/` (proxy), The Quint `thequint.com/stories.rss` (proxy), Kashmir Life `kashmirlife.net/feed/`, Maktoob `maktoobmedia.com/feed/`, Qaumi Awaz `qaumiawaz.com/feed` (Urdu), Munsif `munsifdaily.com/feed/` (Urdu), Newslaundry `newslaundry.com/stories.rss` (proxy). Afghanistan: Ariana `ariananews.af/feed/`, Etilaat-e Roz `etilaatroz.com/feed/`, Rukhshana `rukhshana.com/en/feed`, KabulNow `kabulnow.com/feed/`, Afghanistan Analysts Network `afghanistan-analysts.org/en/feed/`, Radio Azadi `da.azadiradio.com/api/` and `pa.azadiradio.com/api/`, Kabul Times `thekabultimes.com/feed/` (Taliban state). Middle East: Middle East Monitor `middleeastmonitor.com/feed/`, Al-Monitor `al-monitor.com/rss`, Jerusalem Post `jpost.com/rss/rssfeedsfrontpage.aspx`, Arab News `arabnews.pk/rss.xml`, Al Arabiya `english.alarabiya.net/feed/rss2/en.xml` (proxy), Tehran Times `tehrantimes.com/rss`, Mehr `en.mehrnews.com/rss`, The New Arab `newarab.com/rss` (proxy), +972 `972mag.com/feed/` (browser UA), Daily Sabah `dailysabah.com/rss/politics`, Yeni Safak `yenisafak.com/en/rss`, Asharq Al-Awsat `english.aawsat.com/feed`, Mada Masr `madamasr.com/en/feed/`, Enab Baladi `english.enabbaladi.net/feed/`, Saudi Gazette `saudigazette.com.sa/rssFeed/74`. Muslim world: Prothom Alo `en.prothomalo.com/feed`, TBS `tbsnews.net/rss.xml`, Tempo `rss.tempo.co/`, Antara `en.antaranews.com/rss/news.xml`, Free Malaysia Today `freemalaysiatoday.com/feed/`, RFE/RL `rferl.org/api/epiqq`, Kun.uz `kun.uz/news/rss?lang=en`, Times of Central Asia `timesca.com/feed/`, Daily Trust `dailytrust.com/feed/`, Somali Guardian `somaliguardian.com/feed`, 5Pillars `5pillarsuk.com/feed/` (DoH), Muslim Matters `muslimmatters.org/feed/`, CAIR `cair.com/feed/`, Uyghur Times `uyghurtimes.com/feed/`, Myanmar Now `myanmar-now.org/en/feed/`, Irrawaddy `irrawaddy.com/feed`. World: The Diplomat `thediplomat.com/regions/south-asia/feed/`, CFR `cfr.org/feed`, Long War Journal `longwarjournal.org/feed` (blocked from Pakistan), NYT `rss.nytimes.com/services/xml/rss/nyt/World.xml`, Washington Post `feeds.washingtonpost.com/rss/world`, Economist `economist.com/asia/rss.xml`, DW `rss.dw.com/rdf/rss-en-all`, UN News `news.un.org/feed/subscribe/en/news/all/rss.xml`, ReliefWeb `reliefweb.int/updates/rss.xml`, HRW `hrw.org/rss`, Amnesty `amnesty.org/en/feed/`, CPJ `cpj.org/feed/`, Bellingcat `bellingcat.com/feed/`, War on the Rocks `warontherocks.com/feed/`, Bloomberg `feeds.bloomberg.com/politics/news.rss` and FT `ft.com/world?format=rss` (headlines only, paywalled).

| Does not work | Why | Workaround |
| --- | --- | --- |
| Samaa, Dunya, Radio Pakistan, Pajhwok, WAFA, Jakarta Post, The Star (MY), bdnews24, Garowe Online, Bakhtar | No feed found (404, 410 or plain HTML) | YouTube channel RSS or Google News `site:` query |
| ISPR, Urdu Point, Hum News, 92 News, Inquilab, TOLOnews (`tolonews.com/rss.xml` exists behind the challenge), Sudan Tribune, Al Mayadeen, Ahram, Rudaw, Gulf News, The National, The New Humanitarian | Cloudflare or similar hard challenge | Tier 2 stealth fetcher, or skip |
| Indian Express | CloudFront refuses Pakistani and datacenter IPs | Residential proxy only |
| VOA Urdu (last item 16 March 2025), Arab News Urdu (March 2024), Anadolu Urdu (400) | Dormant or broken | Drop |
| Reuters, AP | No public RSS | Google News `site:` queries |

Discovery layer, all verified: Google News RSS `news.google.com/rss/search?q=<q>&hl=en-PK&gl=PK&ceid=PK:en` and the Urdu variant `hl=ur&gl=PK&ceid=PK:ur` return 100 items each (links are redirect wrappers that need `gnews-decoder`); Bing News RSS `bing.com/news/search?q=<q>&format=rss&setlang=ur&cc=PK`; GDELT DOC 2.0 `api.gdeltproject.org/api/v2/doc/doc?query=Pakistan%20sourcelang:urdu&mode=artlist&format=rss&timespan=1d&maxrecords=250` (free, no key, strictly one request per five seconds, about 15 minutes of latency); YouTube `youtube.com/feeds/videos.xml?channel_id=<id>`.

YouTube channel ids, verified: Geo `UC_vt34wimdCzdkrzVejwX9g`, ARY `UCMmpLL2ucRHAXbNHiCPyIyg`, Dunya `UCnMBV5Iw4WqKILKue1nP6Hg`, Samaa `UCJekW1Vj5fCVEGdye_mBN6Q`, Express News `UCTur7oM6mLL0rM2k0znuZpQ`, Hum `UC0Um3pnZ2WGBEeoA3BX2sKw`, Dawn News `UCaxR-D8FjZ-2otbU0_Y2grg`, 92 News `UCsgC5cbz3DE2Shh34gNKiog`, Aaj `UCgBAPAcLsh_MAPvJprIz89w`, Bol `UCz2yxQJZgiB_5elTzqV7FiQ`, GNN `UC35KuZBNIj4S5Ls0yjY-UHQ`, ISPR `UCEwlPFzuck7KyNAnsujkkFg`, PTV News `UC5RvV_LtR1dxPCVFGw6dxXA`, Radio Pakistan `UCqipFkkctswGKhRtxUkO9xA`, BBC Urdu `UCvm8V4Dwtz0fbPGbpk7RYAg`, DW Urdu `UCV1K26GOlQOB_3sRS8vDzhw`, Independent Urdu `UCAvhohWtYwPdpKVGiMkkKOQ`, NDTV `UCZFMm1mMw0F81Z37aaEzTUA`, The Wire `UChWtJey46brNr7qHQpN6KLQ`, The Quint `UCSaf-7p3J_N-02p7jHzm5tA`, Scroll `UCl8zB2LZOiLLV0jYUMpTEgA`, ThePrint `UCuyRsHZILrU7ZDIAbGASHdA`, Greater Kashmir `UCmzsSbFbWqDRNDem1idwNyQ`, TOLOnews `UCknKEREcKsqhB9DFvT61LZQ`, Ariana `UC1yDKupSUpifv3CtgLqRMAg`, Amu `UCSvJ4Tkd-RqFry7stR1Jjmw`, Pajhwok `UCBwAXmOWUYhk_k_hGPgq9zg`, Al Jazeera English `UCNye-wNBqNL5ZzHSJj3l8Bg`, Al Jazeera Arabic `UCfiwzLy-8yKzIbsmZTzxDgw`, TRT World `UC7fWeaHhqgM4Ry-RMpM2YYw`, Anadolu `UCph-M7aQqpi1fW0BQwn7XUA`, Middle East Eye `UCR0fZh5SBxxMNYdg0VzRFkg`, Times of Israel `UCKM3VQFIITaRegPDkLlLeKA`, Press TV `UCpgY6MdWk3iNSMb5JwoZGbw`, WAFA `UCYvCdX-RomwcpzCsb8hpiFA`, Daily Star BD `UCKSJ5rTXq-pYgAmAOhVS_zQ`, Dhaka Tribune `UCB58cDLM3zZlgV6iIG9bdoQ`, Premium Times `UCKEx72IVpUVXvTBjBeZzOLQ`, Sudan Tribune `UCrnkurRbU8ftAXCPKoONFbg`, 5Pillars `UCl791j-PxhtLRyRUi2aP9jQ`, BBC News `UC16niRr50-MSBwiO3YDb3RA`, Reuters `UChqUTb7kYRX8-EiaN3XFrSQ`, AP `UC52X5wxOL_s5yw0dQk7NtgA`.

Telegram public channels that render (checked through a proxy, since t.me is blocked in Pakistan): aljazeera, trtworld, timesofisrael, PressTV, IRNA\_En, MiddleEastMonitor, PalestineChronicle, TheCradleMedia, RFERL, electronicintifada, afintl, amutv; geonews and thewire\_in render but their official status is unconfirmed. Pakistani outlets otherwise have no real channels.

Urdu feed handling: all working Urdu feeds are UTF-8 on the wire, but Geo and The News send an ISO-8859-1 header, so force UTF-8 in the parser; Jang, NDTV and the Quintype sites omit the XML encoding declaration; Express uses a two-digit year in `pubDate`, so use a lenient date parser.

| News API | Free tier | Paid entry | Urdu |
| --- | --- | --- | --- |
| [NewsAPI.org](https://newsapi.org/pricing) | 100 requests a day, 24-hour delay | 449 dollars a month | Poor |
| [Newsdata.io](https://newsdata.io/blog/pricing-plan-in-newsdata-io) | 200 credits a day, 12-hour delay | 199.99 dollars a month | Has `ur` and PK filters |
| [GNews.io](https://gnews.io/pricing) | 100 requests a day, 12-hour delay | 49.99 euros a month | Limited |
| [Mediastack](https://mediastack.com/pricing) | 100 requests a month | 24.99 dollars a month | Not confirmed |
| [Perigon](https://perigon.io/products/pricing/apis) | 150 requests a month, personal | 250 dollars a month | Limited |
| GDELT DOC 2.0 | Unlimited at one request per five seconds | Free | `sourcelang:urdu` |
| [Tavily](https://tavily.com/pricing) | 1,000 credits a month | 0.008 dollars a credit | Search only |
| [Exa](https://exa.ai/pricing) | 10 dollars credit a month | 7 dollars per thousand searches | Search only |
| [SerpAPI](https://serpapi.com/pricing) | 250 searches a month | 25 dollars for 1,000 | Google News engine |
| Brave Search API | Free plan removed February 2026 | 5 dollars per thousand | Search only |

None of the paid news APIs is worth it for this product; the verified feeds plus Google News RSS, GDELT and YouTube cover the groups for free.

## Coverage audit and expansion, 29 September 2026 (D10, D11)

**Method.** Every source in `web/db/seed/sources.json` was read once from this laptop (a residential connection in
Pakistan, direct route only: the SSH tunnel to Germany was down) by the worker's own reader,
`uv run python -m teenpehr.fetch.audit ../web/db/seed/sources.json --write-seed`. It goes through the same code as
a run (`fetch/kinds.read`: the same fetcher, parsers and robots.txt rules), one request per host at a time and
at least 2 seconds apart, with 429 cooldowns shared across processes (a 429 stops all requests to that host for
15 minutes), robots.txt read and recorded for every host, and never the Germany route (`--germany` reads rows
already routed through Germany that way once the tunnel is back). A host that resets the TLS handshake or times
out on connect is recorded as `needs_germany`; a Cloudflare, DataDome or Akamai wall as `challenge`. Neither is
worked around. Each seed row now carries its `check` (status, reason, entries, age of the newest entry, robots.txt
verdict, time). Rows that failed only for a passing reason (429, timeout, 5xx) were re-checked after the cooldowns.
`npm run sources:apply` (`web/scripts/apply-sources.ts`) then upserts every row by group and URL (a row's
`previous_urls` let a moved feed keep its history) and sets `active` only where the check is `ok`; an existing
row that failed only for a passing reason keeps its current state.

**Techniques, in order of preference** (RSS first):

1. **The publisher's own RSS or Atom feed.** Feeds are published for readers, so robots.txt is recorded but is
   not a gate for them.
2. **The publisher's Google News sitemap** (source kind `sitemap`, `fetch/sitemap.py`): the publisher's own list
   of what it published in the last two days, with headline, date, language and often an image. Read only where
   robots.txt allows the sitemap's path; an index is followed to its newest one or two children. Only the
   publisher's own site counts: a child sitemap or an article link on another site is dropped (`sitemap.site_of`),
   so a source never cites another outlet's page under its own name. A sitemap lists
   everything the outlet printed, so a URL fragment picks the news sections by path
   (`#include=/national/,/international/`, `#exclude=/sport`); the fragment is never sent to the server. Sitemaps
   carry no summary, so the collector fetches a short article body for these items the way it does for Google
   News items (robots.txt, Crawl-delay, the per-run budget).
3. **Google News search RSS** (`gnews`), one outlet per source: `site:` queries with `hl`/`gl` for wires that
   publish no feed (Reuters, AP, and AFP through its own site, `site:afp.com`) and for outlets whose own hosts reset
   connections from Pakistan or sit behind a bot wall (The Hindu, Times of India, ThePrint, The Quint,
   Newslaundry, India Today, The Daily Star, DW, +972 Magazine, Sudan Tribune, Xinhua). Links are decoded by the
   worker; the article page is then fetched only where robots.txt allows it and the host answers. A source is one
   outlet everywhere in the product (the chip, the perspective label), so mixed-outlet topic feeds were not added.
4. **YouTube channel feeds** of major TV news. Channel ids came from each channel page's canonical link
   (robots.txt allows `/@handle`); each feed's own title confirmed the channel.
5. **GDELT DOC 2.0** (`gdelt`, `fetch/gdelt.py`): implemented (one request per 5.5 s process-wide, robots.txt,
   plain-text error answers reported rather than parsed) and seeded for three Urdu outlets that have no feed, a bot
   wall on the feed or nothing on Google News (Geo Urdu, Hum News Urdu, Inquilab), one outlet each
   (`domainis:`). **Not verified live:** GDELT answered HTTP 429 to single requests made 15 minutes apart from this
   connection all morning (most likely a shared carrier-grade NAT address). The three rows stay off until an
   audit reads them; the Germany route is not used to get past a rate limit.
6. **Bluesky** outlet accounts, checked through the public API (`app.bsky.feed.getAuthorFeed`), added to
   `web/db/seed/handles.json`.
7. **Telegram:** `t.me` and `telegram.org` time out on connect from Pakistan (25 s): needs the Germany route.
   The worker has no Telegram reader, so no Telegram source was seeded; the channels listed under the seed source
   pack above remain the candidates once the tunnel is back.

**Other fixes the audit found.** `hindustantimes.com` resets connections but `www.hindustantimes.com` answers, so
the Hindustan Times row moved to the `www` host; Scroll's feed answers directly again; the Middle East "Arab News"
row pointed at the Pakistan edition (`arabnews.pk`), which is now its own Pakistan source; Aaj's feed is Urdu, not
English; Dawn News (Urdu) stopped its RSS in January 2026 and is read from its news sitemap; the Times of Israel
feed is behind a Cloudflare challenge while its news sitemap is open; Qaumi Awaz, Prothom Alo and The Business
Standard have empty or dead feeds and working news sitemaps; the Afghanistan Analysts Network feed lives on the
`www` host. Some hosts reset connections intermittently (Siasat and 5Pillars answered at 04:07 and reset at 05:12);
their route stays `direct`, since a run tries the direct route first and Germany only when the host is blocked.

**A fair share per source.** With many more feeds per group, the curation list (120 articles a group) used to be
filled in source order, so later sources could be cut entirely. It is now filled round robin over the group's
feeds, each newest first, whenever the group has more than 120 (`pipeline.round_robin`).

**Result.** 271 sources in the seed, 253 working today (the dev database: 253 active of 271: IRNA kept on after
a passing 504, Malay Mail World kept off by choice, since it overlaps the World group). On 23 September 62 of 182 were active.

| Group | Seeded 23 Sep (active) | In the seed now | Working today | Added |
| --- | --- | --- | --- | --- |
| Pakistan | 45 (19) | 61 | 58 | 16 |
| India | 24 (9) | 42 | 35 | 18 |
| Afghanistan | 18 (6) | 29 | 29 | 11 |
| Middle East | 37 (11) | 50 | 46 | 13 |
| Muslim world | 29 (7) | 43 | 40 | 14 |
| World | 29 (10) | 46 | 45 | 17 |
| **Total** | **182 (62)** | **271** | **253** | **89** |

By kind: RSS 149 of 161 working, news sitemaps 19 of 20, Google News 33 of 33, YouTube 52 of 54, GDELT 0 of 3.
New Google News sources take at most 4 items a run: every Google News link costs one page fetch and a share of a
batch request to decode, one host at one request a second.

**New sources** (verified live on 29 September, except the three GDELT rows; "newest" is the age of the newest
entry at the check):

| Group | Outlet | Kind | Lang | Where | Check |
| --- | --- | --- | --- | --- | --- |
| Pakistan | Samaa | news sitemap | en | `www.samaa.tv/sitemap-news.xml` | ok, 49 items, newest 6 h |
| Pakistan | Roznama Dunya | news sitemap | ur | `dunya.com.pk/newweb/dunya_html/dunya_json_front/rss_feed/aj_ka_akhbar_sitemap.xml` `#include=/index.php/pakistan,/index.php/business` | ok, 68 items, newest 24 h |
| Pakistan | Bol News | news sitemap | en | `bolnews.com/news-sitemap.xml` `#include=/pakistan/,/business/,/world/` | off: every link is on a bare IP address (see below) |
| Pakistan | Hum News English | RSS | en | `humenglish.com/feed/` | ok, 20 items, newest 5 h |
| Pakistan | Arab News Pakistan | RSS | en | `www.arabnews.pk/rss.xml` | ok, 50 items, newest 1 h |
| Pakistan | Minute Mirror | RSS | en | `minutemirror.com.pk/feed/` | ok, 100 items, newest 2 h |
| Pakistan | Pakistan Observer | RSS | en | `pakobserver.net/feed/` | ok, 10 items, newest 6 h |
| Pakistan | Reuters Pakistan | Google News | en | `site:reuters.com pakistan when:2d` (en-PK, PK) | ok, 31 items, newest 0 h |
| Pakistan | AP Pakistan | Google News | en | `site:apnews.com pakistan when:2d` (en-PK, PK) | ok, 18 items, newest 2 h |
| Pakistan | Aaj English | news sitemap | en | `english.aaj.tv/feeds/sitemap` | ok, 100 items, newest 0 h |
| Pakistan | 24 News HD (YouTube) | YouTube | ur | `UCcmpeVbSSQlZRvHfdC-CRwg` | ok, 15 items, newest 1 h |
| Pakistan | Radio Pakistan | Google News | en | `site:radio.gov.pk when:2d` (en-PK, PK) | ok, 87 items, newest 1 h |
| Pakistan | Pakistan Today | Google News | en | `site:pakistantoday.com.pk when:2d` (en-PK, PK) | ok, 100 items, newest 0 h |
| Pakistan | AFP Pakistan | Google News | en | `site:afp.com pakistan when:3d` (en-PK, PK) | ok, 6 items, newest 15 h |
| Pakistan | Geo Urdu | GDELT | ur | `domainis:urdu.geo.tv` | rate limited |
| Pakistan | Hum News Urdu | GDELT | ur | `domainis:humnews.pk` | rate limited |
| India | PTI | news sitemap | en | `www.ptinews.com/news-sitemap.xml` `#include=/story/national,/story/international,/story/business` | ok, 1544 items, newest 6 h |
| India | Deccan Herald | news sitemap | en | `www.deccanherald.com/news_sitemap.xml` `#include=/india/,/world/` | ok, 268 items, newest 0 h |
| India | The Tribune (India) | news sitemap | en | `www.tribuneindia.com/sitemap-news.xml` `#include=/news/india/,/news/j-k/,/news/world/` | ok, 176 items, newest 2 h |
| India | Outlook | news sitemap | en | `www.outlookindia.com/oisitemap-news.xml` `#include=/national/,/international/` | ok, 141 items, newest 8 h |
| India | BBC India | RSS | en | `feeds.bbci.co.uk/news/world/asia/india/rss.xml` | ok, 31 items, newest 25 h |
| India | Guardian India | RSS | en | `www.theguardian.com/world/india/rss` | ok, 20 items, newest 61 h |
| India | Reuters India | Google News | en | `site:reuters.com india when:2d` (en-IN, IN) | ok, 100 items, newest 2 h |
| India | The Hindu (Google News) | Google News | en | `site:thehindu.com when:1d` (en-IN, IN) | ok, 100 items, newest 3 h |
| India | Times of India (Google News) | Google News | en | `site:timesofindia.indiatimes.com india when:1d` (en-IN, IN) | ok, 100 items, newest 0 h |
| India | ThePrint (Google News) | Google News | en | `site:theprint.in when:1d` (en-IN, IN) | ok, 100 items, newest 5 h |
| India | The Quint (Google News) | Google News | en | `site:thequint.com when:2d` (en-IN, IN) | ok, 21 items, newest 11 h |
| India | Newslaundry (Google News) | Google News | en | `site:newslaundry.com when:3d` (en-IN, IN) | ok, 11 items, newest 11 h |
| India | India Today | Google News | en | `site:indiatoday.in india when:1d` (en-IN, IN) | ok, 100 items, newest 1 h |
| India | WION (YouTube) | YouTube | en | `UC_gUM8rL-Lrg6O3adPW9K1g` | ok, 15 items, newest 5 h |
| India | India Today (YouTube) | YouTube | en | `UCYPvAwZP8pZhSMW8qs7cVCw` | ok, 15 items, newest 3 h |
| India | Clarion India | Google News | en | `site:clarionindia.net when:3d` (en-IN, IN) | ok, 47 items, newest 8 h |
| India | Muslim Mirror | Google News | en | `site:muslimmirror.com when:3d` (en-IN, IN) | ok, 13 items, newest 13 h |
| India | Inquilab | GDELT | ur | `domainis:inquilab.com` | rate limited |
| Afghanistan | BBC Pashto | RSS | ps | `feeds.bbci.co.uk/pashto/rss.xml` | ok, 14 items, newest 9 h |
| Afghanistan | BBC Persian | RSS | fa | `feeds.bbci.co.uk/persian/rss.xml` | ok, 28 items, newest 1 h |
| Afghanistan | Guardian Afghanistan | RSS | en | `www.theguardian.com/world/afghanistan/rss` | ok, 20 items, newest 30 h |
| Afghanistan | Hasht-e Subh (Persian) | news sitemap | fa | `8am.media/fa/sitemap-news.xml` | ok, 102 items, newest 0 h |
| Afghanistan | Reuters Afghanistan | Google News | en | `site:reuters.com (afghanistan OR taliban) when:3d` (en-US, US) | ok, 100 items, newest 0 h |
| Afghanistan | TOLOnews | Google News | en | `site:tolonews.com when:2d` (en-US, US) | ok, 100 items, newest 2 h |
| Afghanistan | Zan Times | RSS | en | `zantimes.com/feed/` | ok, 10 items, newest 130 h |
| Afghanistan | Afghanistan International (YouTube) | YouTube | fa | `UCI66K57kW6e9erEkY_n_JRA` | ok, 15 items, newest 4 h |
| Afghanistan | BBC Pashto (YouTube) | YouTube | ps | `UCu7qsdVTUWcI_PclOr8z51Q` | ok, 15 items, newest 6 h |
| Afghanistan | Bakhtar | Google News | en | `site:bakhtarnews.af/en -Tag when:3d` (en-US, US) | ok, 31 items, newest 9 h |
| Afghanistan | Pajhwok | Google News | en | `site:pajhwok.com when:3d` (en-US, US) | ok, 6 items, newest 13 h |
| Middle East | AP Middle East | Google News | en | `site:apnews.com (israel OR gaza OR iran OR lebanon OR syria OR yemen OR iraq) when:1d` (en-US, US) | ok, 100 items, newest 0 h |
| Middle East | Reuters Middle East | Google News | en | `site:reuters.com (israel OR gaza OR iran OR lebanon OR syria OR yemen OR iraq) when:1d` (en-US, US) | ok, 100 items, newest 2 h |
| Middle East | Egypt Independent | RSS | en | `www.egyptindependent.com/feed/` | ok, 10 items, newest 10 h |
| Middle East | Gulf News | news sitemap | en | `gulfnews.com/news_sitemap.xml` `#include=/world/,/uae/` | ok, 153 items, newest -0 h |
| Middle East | Iran International (English) | news sitemap | en | `www.iranintl.com/sitemap.xml` `#include=/en/` | ok, 133 items, newest 1 h |
| Middle East | Khaleej Times World | RSS | en | `www.khaleejtimes.com/api/v1/collections/world.rss` | ok, 40 items, newest 7 h |
| Middle East | Khaleej Times UAE | RSS | en | `www.khaleejtimes.com/api/v1/collections/uae.rss` | ok, 40 items, newest 5 h |
| Middle East | Naharnet | RSS | en | `www.naharnet.com/tags/lebanon/en/feed.atom` | ok, 10 items, newest 10 h |
| Middle East | The National | news sitemap | en | `www.thenationalnews.com/arc/outboundfeeds/news-sitemap/?outputType=xml` `#include=/news/` | ok, 52 items, newest 4 h |
| Middle East | Ynetnews | RSS | en | `www.ynetnews.com/Integration/StoryRss3082.xml` | ok, 30 items, newest 53 h |
| Middle East | +972 Magazine (Google News) | Google News | en | `site:972mag.com when:7d` (en-US, US) | ok, 7 items, newest 2 h |
| Middle East | Al Arabiya English (YouTube) | YouTube | en | `UCIZJ9a6P_nxCFJTmL0gh_IQ` | ok, 15 items, newest 1 h |
| Middle East | WAFA | Google News | en | `site:english.wafa.ps when:3d` (en-US, US) | ok, 48 items, newest 3 h |
| Muslim world | AKIpress | RSS | en | `akipress.com/rss/en.rss` | ok, 20 items, newest 4 h |
| Muslim world | AP Muslim world | Google News | en | `site:apnews.com (bangladesh OR indonesia OR malaysia OR sudan OR somalia OR uyghur OR rohingya) when:2d` (en-US, US) | ok, 51 items, newest 2 h |
| Muslim world | Reuters Muslim world | Google News | en | `site:reuters.com (bangladesh OR indonesia OR malaysia OR sudan OR somalia OR uzbekistan OR kazakhstan OR uyghur OR rohingya) when:2d` (en-US, US) | ok, 100 items, newest 0 h |
| Muslim world | CNA Asia | RSS | en | `www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511` | ok, 19 items, newest 2 h |
| Muslim world | Guardian Bangladesh | RSS | en | `www.theguardian.com/world/bangladesh/rss` | ok, 20 items, newest 16 h |
| Muslim world | Guardian Indonesia | RSS | en | `www.theguardian.com/world/indonesia/rss` | ok, 20 items, newest 189 h |
| Muslim world | Hiiraan Online | RSS | en | `hiiraan.com/news.xml` | ok, 20 items, newest 4 h |
| Muslim world | Malaysiakini | RSS | en | `www.malaysiakini.com/rss/en/news.rss` | ok, 10 items, newest 13 h |
| Muslim world | RFA English | news sitemap | en | `rfa.org/arc/outboundfeeds/english/sitemap-news/` `#include=/english/uyghur,/english/myanmar,/english/china` | ok, 22 items, newest 75 h |
| Muslim world | The Jakarta Post | news sitemap | en | `www.thejakartapost.com/sitemap_news.xml` `#include=/indonesia/,/world/,/business/` | ok, 25 items, newest 0 h |
| Muslim world | bdnews24 | news sitemap | en | `bdnews24.com/news_sitemap.xml` `#include=/bangladesh/,/world/,/neighbours/,/business/` | ok, 86 items, newest 2 h |
| Muslim world | The Daily Star (Google News) | Google News | en | `site:thedailystar.net when:1d` (en-US, US) | ok, 100 items, newest 0 h |
| Muslim world | Sudan Tribune | Google News | en | `site:sudantribune.com when:3d` (en-US, US) | ok, 100 items, newest 1 h |
| Muslim world | CNA (YouTube) | YouTube | en | `UC83jt4dlz1Gjl58fzQrrKZg` | ok, 15 items, newest 0 h |
| World | AFP (Google News) | Google News | en | `site:afp.com (china OR russia OR ukraine OR "united nations" OR trump OR climate OR economy) when:1d` (en-US, US) | ok, 68 items, newest 0 h |
| World | France 24 | RSS | en | `www.france24.com/en/rss` | ok, 24 items, newest 0 h |
| World | NPR World | RSS | en | `feeds.npr.org/1004/rss.xml` | ok, 10 items, newest 2 h |
| World | Sky News World | RSS | en | `feeds.skynews.com/feeds/rss/world.xml` | ok, 10 items, newest 4 h |
| World | CBC World | RSS | en | `www.cbc.ca/webfeed/rss/rss-world` | ok, 20 items, newest 2 h |
| World | ABC Australia | RSS | en | `www.abc.net.au/news/feed/51120/rss.xml` | ok, 25 items, newest 1 h |
| World | SCMP | RSS | en | `www.scmp.com/rss/91/feed` | ok, 50 items, newest 0 h |
| World | TASS | RSS | en | `tass.com/rss/v2.xml` | ok, 100 items, newest 0 h |
| World | The Independent World | RSS | en | `www.independent.co.uk/news/world/rss` | ok, 63 items, newest 1 h |
| World | Politico | RSS | en | `www.politico.com/rss/politicopicks.xml` | ok, 36 items, newest 3 h |
| World | UN News (Asia Pacific) | RSS | en | `news.un.org/feed/subscribe/en/news/region/asia-pacific/feed/rss.xml` | ok, 30 items, newest 60 h |
| World | DW (Google News) | Google News | en | `site:dw.com/en when:1d` (en-US, US) | ok, 100 items, newest 1 h |
| World | Xinhua | Google News | en | `site:english.news.cn when:1d` (en-US, US) | ok, 100 items, newest 0 h |
| World | DW News (YouTube) | YouTube | en | `UCknLrEdhRCp1aegoMqRaCZg` | ok, 15 items, newest 0 h |
| World | Sky News (YouTube) | YouTube | en | `UCoMdktPbSTixAyNGwb-UYkQ` | ok, 15 items, newest 1 h |
| World | France 24 English (YouTube) | YouTube | en | `UCQfwfsi5VrQ8yKZ-UWmAEFg` | ok, 15 items, newest 3 h |
| World | CGTN (YouTube) | YouTube | en | `UCgrNz-aDmcr2uuto8_DL2jg` | ok, 15 items, newest 9 h |


**Existing rows changed:**

| Group | Outlet | Change | Check |
| --- | --- | --- | --- |
| Pakistan | Dawn News | RSS → news sitemap `www.dawnnews.tv/feeds/sitemap` | ok, 100 items, newest 0 h |
| India | Scroll | route germany → direct | ok, 100 items, newest 8 h |
| India | Hindustan Times | URL → `www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml`; route germany → direct | ok, 100 items, newest 2 h |
| India | Siasat | route germany → direct | needs germany |
| Middle East | Times of Israel | RSS → news sitemap `www.timesofisrael.com/news-sitemap.xml` | ok, 179 items, newest 1 h |
| Pakistan | Aaj | lang en → ur | ok, 30 items, newest 5 h |
| India | Qaumi Awaz | RSS → news sitemap `www.qaumiawaz.com/news_sitemap.xml` `#include=/national/,/international/,/other-countries/,/arab-world/,/political/` | ok, 58 items, newest 6 h |
| Afghanistan | Afghanistan Analysts Network | URL → `www.afghanistan-analysts.org/en/feed/` | ok, 12 items, newest 8 h |
| Middle East | Arab News | URL → `www.arabnews.com/rss.xml` | ok, 50 items, newest 1 h |
| Muslim world | Prothom Alo | RSS → news sitemap `en.prothomalo.com/news_sitemap.xml` `#include=/bangladesh/,/international/` | ok, 42 items, newest 8 h |
| Muslim world | The Business Standard | RSS → news sitemap `www.tbsnews.net/googlenews.xml` `#include=/bangladesh/,/economy/,/world/,/foreign-policy/` | ok, 291 items, newest 4 h |
| India | The Wire, Siasat Urdu | route germany → direct | ok directly |
| Afghanistan | Radio Azadi (Dari), Radio Azadi (Pashto) | route germany → direct | ok directly |
| Middle East | Al Arabiya, The New Arab | route germany → direct | ok directly |
| World | Long War Journal | route germany → direct | ok directly |
| Muslim world | Malay Mail World | kept off (the seed row's own note: it overlaps the World group) | ok |

**Review of 29 September** (a second pass over the work above):

- *Germany only for reach.* Seven rows routed through Germany answered directly in the audit, yet a run would still
  have sent them through the tunnel (down today, so they would have failed on every run while counted as active).
  Their route is now `direct`; a run falls back to Germany only if a host is blocked again. The audit now flags a
  `germany` row that answers directly, and `sources:apply` lists any such row it activates.
- *One outlet per source, AFP included.* `intitle:pakistan AFP` matched any outlet that mentioned AFP: on the
  review's check it returned Dawn and The Express Tribune articles, which would have been cited as "AFP Pakistan"
  under AFP's perspective label (and could take an article away from Dawn's own source in the same group). The
  World row's `"AFP"` query over France 24, Barron's and RFI had the same flaw (France 24 is its own World source).
  Both now search AFP's own site, `site:afp.com` (one outlet: AFP and AFP Fact Check), verified live.
- *A sitemap cites only its own site.* The Bol News sitemap lists every article on the bare address
  `https://34.192.131.30/…` instead of `bolnews.com`: links a reader cannot use and the outlet does not publish. The
  reader now drops children and articles on another site than the sitemap's own; Bol News then reads as a parse
  error and is off (it has no RSS feed; its YouTube channel is on). The other 19 sitemaps read as before.
- *Malay Mail World* stays off, as its seed note says (it overlaps the World group); the expansion had switched it on.


**Not working today** (kept in the seed and off in the database, except IRNA, left on after a passing 504;
`needs germany` hosts come back with the tunnel, through `audit --germany`):

| Group | Outlet | Kind | Check | Why |
| --- | --- | --- | --- | --- |
| India | The Hindu | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| India | Siasat | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| Middle East | Al Jazeera English (RSS) | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| Middle East | IRNA | RSS | http error | http 504 |
| Muslim world | The Daily Star | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| India | Times of India | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| India | ThePrint | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| India | The Quint | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| India | Newslaundry | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| Middle East | +972 Magazine | RSS | challenge | Cloudflare challenge (http 403); needs a tier-2 browser, never evaded |
| Muslim world | 5Pillars | RSS | needs germany | unreachable directly: SSLError: Failed to perform, curl: (35) Recv failure: Connection reset by peer. |
| World | ReliefWeb | RSS | empty | no entries in a text/html; charset=UTF-8 of 2279 bytes |
| Middle East | Press TV (YouTube) | YouTube | stale | newest entry 33 days old |
| Muslim world | Sudan Tribune (YouTube) | YouTube | stale | newest entry 209 days old |
| Pakistan | Geo Urdu | GDELT | rate limited | http 429 |
| Pakistan | Hum News Urdu | GDELT | rate limited | http 429 (on robots.txt) |
| India | Inquilab | GDELT | rate limited | http 429 (on robots.txt) |
| Pakistan | Bol News | news sitemap | parse error | every article link is on the bare address 34.192.131.30, not bolnews.com; no RSS feed |


Where an outlet above has a replacement, it is in the new sources: The Hindu, Times of India, ThePrint, The
Quint, Newslaundry, The Daily Star and +972 Magazine through Google News, Al Jazeera English through its existing
Google News source, Press TV through IRNA, Tehran Times and Mehr (Iranian state media), Sudan Tribune through
Google News. Siasat's English site and 5Pillars have none; both answered directly at 04:07 and reset at 05:12, so
their route stays `direct` (a run tries direct first and Germany only for a blocked host).

Tried and not added: Geo Urdu's plain sitemap (unreadable) and its news sitemap (last entry 2022), Hum News Urdu's
feed (Cloudflare challenge), Inquilab (no feed or news sitemap; Google News lists only old pages), Muslim Mirror's
feed (Cloudflare challenge) and Clarion India's site (403) (both added through Google News instead), Pajhwok's feed (410; added through Google
News), Bakhtar's sitemap (not a news sitemap; added through Google News, English pages only, tag pages excluded),
UNAMA and WAFA English feeds (404), L'Orient Today and the Saudi Press Agency sitemaps (no news entries), Ahram
Online and Rudaw (Google News returns only section pages), Pakistan Today's and Profit's feeds (404; Pakistan
Today added through Google News), Radio Pakistan's sitemap (404; added through Google News), Mashriq TV (no news
sitemap), the Express Tribune `latest` sitemap (not a news sitemap; its RSS works), Dunya News's sitemap
(answered at 04:16, then timed out twice; its YouTube channel is on), VOA (empty), CNN's and Xinhua's own RSS (last entries 2023 and 2017; Xinhua added
through Google News), Global Times (RSS 37 days old), AP's own feed (DataDome wall; AP comes through Google News),
AP's news sitemap and the BBC's (every desk, sport included, with no section in the URL to filter on; their
RSS and Google News sources cover them), Reuters' news sitemap (robots.txt disallows it), Bernama (RSS entries
carry no dates), Shamshad TV's YouTube channel (mostly religious and entertainment programmes), a second
Afghanistan International YouTube channel (empty feed) and "WIOnews" (a dormant namesake of WION).

**Bluesky** (`handles.json`, verified through `app.bsky.feed.getAuthorFeed` with fresh posts from the account
itself): World: reuters.com, apnews.com, theguardian.com, nytimes.com, washingtonpost.com, france24.com, npr.org,
economist.com, bloomberg.com, thediplomat.com, bellingcat.com, hrw.org; Middle East: 972mag.com, mondoweiss.net.
Three seeded Bluesky handles have not posted since early 2025 and are marked inactive in the seed
(tolonews.bsky.social, geonewsurdu.bsky.social, ravishndtv.bsky.social); `aljazeera.com` answered 502 twice.
`sources:apply --handles` only adds handles, so the dev database's copies of these three are unchanged. Dawn,
DW, Middle East Eye, Haaretz, CPJ and RFE/RL have no handle that resolves; The Hindu's (24 days) and The Indian
Express's (16 months) accounts are dormant.

**X Lists (D10, the research half).** Web searches found public lists only as old `owner/slug` addresses; none
gave a numeric `x.com/i/lists/<id>`. Candidates: Pakistan `dawn_com/pakistan-journalists` (Dawn's own list);
India `ingridtherwath/india-journalists`; Afghanistan `jcravens42/afghanistan`; Middle East
`peterben/middle-east-journalists`, `oxenstierna_irl/middle-east-journalists`, `ckanal/middle-east`,
`corybe/israel-gaza-journalists`; World `nytimesworld/nyt-foreign-journalists` (The New York Times' foreign
correspondents), `kautoh/int-journalists`; none for the Muslim world. The syndication endpoint's list-id route
answered at once (X's own list `84839422`: 98 posts, the newest six minutes old), but its screen-name/slug route
answered 429 on every attempt (05:09, 05:27, 05:42 and 05:58, each after a full 15-minute cooldown), and a
signed-out reader cannot turn a slug into an id (x.com resolves it only for a signed-in user; the archived copy of
the NYT list page is a script shell without the id). So none of these could be verified. The review then searched
for list pages indexed by their numeric id (`site:x.com "i/lists"`): searches per region found none, and one
general hit, the Financial Times' own "FT journalists" list (`1687552711401607168`, by @FT, 449 members), was read
once through the list-id route at 01:20 UTC: 98 recent posts (68 of them reposts) from 23 accounts, the newest six
minutes old, 43% of the accounts posting on the World group's subjects, none already watched. It passes the
thresholds below and is the one entry in `web/db/seed/x-list-proposals.json`, proposed for World; nothing
unverified is proposed. The regional candidates above still need their ids: open each
candidate on x.com while signed in, copy the digits of `x.com/i/lists/<id>`, and run
`uv run python -m teenpehr.fetch.xlist_audit --group <slug> <ids…> --write ../web/db/seed/x-list-proposals.json`.
It reads each list once (10 s apart, stopping at a 429), reports entries, authors, the newest post's age,
reposts, overlap with the watched handles and the share of authors posting on the group's subjects, and writes
only lists with at least 20 fresh entries (newest under 48 h) and 30% relevant authors. The admin then shows
them, and only an owner's "Add to group" puts a list id into `groups.x_list_ids`. The tool refuses `owner/slug`
input before any request, since that route's 429 would put X on cooldown for the X collector too.

**Redo this audit:** `cd worker && uv run python -m teenpehr.fetch.audit ../web/db/seed/sources.json --write-seed`
(add `--germany` once the tunnel is back; `--status <status>` re-checks only rows with that recorded status), then
`cd web && npm run sources:apply -- --dry-run` and `npm run sources:apply` (`--db <name>` for a throwaway copy;
`--handles` adds new handles, `--proposals` loads the X List proposals). A row's `active` in the seed is the
intent and its `check` the gate, so on a fresh database run `npm run sources:apply` after `npm run db:seed`, which
reads `active` alone.

## Product benchmarks and names

Twenty-two patterns from the best digest products, each attributed, followed by the name check run on 23 September 2026.

| Pattern | From | What to take |
| --- | --- | --- |
| Semaform sections | [Semafor](https://www.semafor.com/article/10/18/2022/what-is-a-semaform-anyway-and-why-should-you-care) | The News, Reporter's View, Room for Disagreement, The View From, Notable |
| Smart Brevity | [Axios](https://help.axios.com/hc/en-us/articles/36222626161435-What-is-the-Axios-Smart-Brevity-style) | Bold one-sentence lede, Why it matters, 2 to 4 bullets, Go deeper link |
| Finishable edition | [Economist Espresso](https://digiday.com/media/inside-the-relaunch-of-the-economists-subscription-mobile-app/) | Five stories plus World in Brief three times a day; readers ask for archive access |
| Ritual masthead and completion | [Kagi News](https://blog.kagi.com/kagi-news) | Dated masthead, "You've read N stories", "Updated N minutes ago", RSS out |
| Modular story sections | [Kagi News](https://help.kagi.com/kagi/news/) | Summary, Highlights, Quotes, Perspectives, Background, Timeline, Reactions, reorderable |
| Public source list | [Kagi News](https://news.kagi.com/) | Sources and hallucination reports in a public repo; RSS-only ingest |
| Coverage chips and Blindspot | [Ground News](https://ground.news/rating-system) | N sources, bias bar, factuality, ownership, stories one side skips |
| Opposite Sides, summary styles | [Particle](https://techcrunch.com/2024/11/12/particle-launches-an-ai-news-app-to-help-publishers-instead-of-just-stealing-their-work) | Contrasting framings, ELI5 or just-the-facts, TTS, follow entities, oversight pipeline |
| Labelled opinion, rescued story | [Tangle](https://tangle.substack.com/about) | What each side says, then My take; one story drowned out by noise |
| Two-tier depth | [1440](https://www.snopes.com/news/2024/02/01/is-1440-news-unbiased/) | Need to Know then In the Know; fact-check before publishing |
| Tapering length, rituals | [Morning Brew](https://theaudiencers.com/deep-dive-into-the-morning-brew-newsletter-andy-griffiths/) | Markets strip, items shrink as you scroll, Stat, Quote, Read |
| Named host | [NYT The Morning](https://www.niemanlab.org/2020/04/the-new-york-times-morning-email-newsletter-is-getting-an-official-host-and-anchor/) | A person hosts the edition |
| Smart-friend voice | [theSkimm](https://www.cjr.org/criticism/the-skimm-newsletter-critique.php) | Conversational register for the evening edition, always link out |
| Structural attribution | [Perplexity Discover](https://www.searchenginejournal.com/perplexitys-discover-pages-offer-a-surprising-seo-insight/554638/) | Every claim maps to a numbered source |
| Same edition for everyone | [Apple News](https://s2n.news/blog/news-aggregators-google-apple-bing-what-youre-missing) | Human curation beat algorithms on source diversity |
| Scope discipline | [Artifact](https://techcrunch.com/2024/01/18/why-artifact-from-instagrams-founders-failed-shut-down/) | AI headlines loved; product died after diluting into links and social |
| Optional extractive takeaways | [Yahoo](https://www.niemanlab.org/2025/06/lets-get-to-the-point-three-newsrooms-on-generating-ai-summaries-for-news/) | Summary behind a tap, drawn only from the article |
| Nutrition label | [Otherweb](https://www.axios.com/pro/media-deals/2024/10/17/otherweb-news-filter-app) | Sensationalism flag on source headlines |
| Story points and resume | [Circa](https://en.wikipedia.org/wiki/Circa_News) | A story is an entity gaining dated points; follow and resume |
| Reader-chosen frequency | [Substack](https://post.substack.com/p/yws) | Daily versus weekly digest toggle |
| Simplified edition | [NHK News Web Easy](https://nhkeasier.com/about/) | Plain language, slow audio, glossary, link to original |
| No AI push copy | [Apple Intelligence pause](https://www.axios.com/2025/01/17/apple-ai-news-alerts-fake-headlines) | Hallucinated BBC headlines forced a suspension |

Bilingual precedent: BBC World Service, Al Jazeera, DW and Independent Urdu all run separate language services linked by a site-level language menu, not per-article translation toggles. Independent Urdu mixes translated pieces with original Islamabad reporting.

Elder mode precedent: China's MIIT elder-mode specification (2021) requires text of at least 18 pt, contrast of at least 4.5:1, line height of at least 1.3, a prominent entrance on the home page, no ads or pop-ups, fewer features and larger targets, applied on every page ([spec summary](https://www.thepaper.cn/newsDetail_forward_12083101)).

| Name | Meaning | Availability on 23 Sep 2026 |
| --- | --- | --- |
| Teen Pehr تین پہر | Three watches of the day, literally the three editions | teenpehr.com no WHOIS match; .pk, .app, .news no DNS. Top pick |
| Sarnama سرنامہ | Headline | sarnama.com no match; .pk no DNS |
| Nashriyat نشریات | Broadcasts | nashriyat.com no match; .pk, .app no DNS |
| Subh-o-Shaam صبح و شام | Morning and evening | subhosham.com no match |
| Waqt-Nama وقت نامہ | Chronicle of the hour | waqtnama.com no DNS |
| Teen Waqt تین وقت | Three times, echoes Nawa-i-Waqt | teenwaqt.com no match; .pk no DNS |
| Subh-Nama صبح نامہ | Morning chronicle | subhnama.com no match; .pk no DNS |
| Khabarnama خبرنامہ | Classic PTV bulletin | Taken: khabarnama.com registered, [khabarnama.pk](https://www.khabarnama.pk/) is a live news site |
| Khulasa خلاصہ | Summary | Taken: khulasa.com and .pk registered; a Khulasa News app exists |
| Jaiza جائزہ | Review | jaiza.com registered; jaiza.pk no DNS |
| Akhbarnama اخبارنامہ |  | akhbarnama.com parked; .pk no DNS |

Domain checks were DNS plus .com WHOIS; a .pk with no DNS is a strong signal but confirm at PKNIC before committing.
