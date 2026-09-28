#!/usr/bin/env python3
"""End-to-end smoke test of the worker API against a running web app.

It writes and PUBLISHES fabricated news (example.org sources, an invented post). Published editions are
immutable and raw items feed later runs, so it refuses to write anything unless the server reports (via
/api/worker/health) a database whose name ends in "_smoke". Editions go on year-2000 dates, which never
collide with real slots or snapshot files. Set up a throwaway database once, then run the app on it:

    docker compose exec db createdb -U teenpehr teenpehr_smoke          # from the repo root
    cd web && export DATABASE_URL=postgres://teenpehr:teenpehr@127.0.0.1:5432/teenpehr_smoke
    npm run db:push -- --force && npm run db:seed
    EDITION_SNAPSHOT_DIR=/tmp/teenpehr-smoke-snapshots npx next dev -p 3100
    python3 scripts/smoke.py http://localhost:3100

The reader pages are behind the login wall (docs/PLAN.md D2). To check them, give the script an account
on the smoke database: `npm run user:invite -- --email smoke@example.org` (with DATABASE_URL as above),
accept the link in a browser, then set SMOKE_EMAIL and SMOKE_PASSWORD. Without them it checks that
every page sends a signed-out visitor to sign in instead.

Reads WORKER_TOKEN from the environment, else from web/.env.local. Usage: smoke.py [base_url]
"""
import datetime as dt, json, os, sys, urllib.request, urllib.error, urllib.parse, hashlib, pathlib, zoneinfo

base = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000").rstrip("/")
token = os.environ.get("WORKER_TOKEN")
if not token:
    env_file = pathlib.Path(__file__).resolve().parent.parent / ".env.local"
    env = dict(l.strip().split("=", 1) for l in env_file.read_text().splitlines() if "=" in l and not l.startswith("#"))
    token = env["WORKER_TOKEN"]

def call(method, path, body=None, auth=True, expect=(200, 201)):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if auth else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read(); status = r.status
    except urllib.error.HTTPError as e:
        data = e.read(); status = e.code
    text = data.decode()
    ok = status in expect
    print(f"{'OK ' if ok else 'FAIL'} {method} {path} -> {status} {text[:160].replace(chr(10),' ')}")
    if not ok: sys.exit(1)
    try: return json.loads(text)
    except Exception: return text

def check(cond, what):
    print(f"{'OK ' if cond else 'FAIL'}    {what}")
    if not cond: sys.exit(1)

call("GET", "/api/worker/health", auth=False, expect=(401,))
h = call("GET", "/api/worker/health")
if not str(h.get("database", "")).endswith("_smoke"):
    sys.exit(f"REFUSED: {base} uses database {h.get('database')!r}. This script publishes fabricated editions, which can never "
             "be removed from a real archive. Start the app on a throwaway database named *_smoke (see this file's docstring).")

now = dt.datetime.now(zoneinfo.ZoneInfo("Asia/Karachi"))
# First year-2000 date with no edition in any slot, so reruns against the same smoke database keep working.
def has_edition(day, slot):
    return "edition_id" in call("GET", f"/api/worker/editions/{day}/{slot}", expect=(200, 404))
day = dt.date(2000, 1, 1)
while any(has_edition(day, s) for s in ("subh", "dopahar", "shaam")):
    day += dt.timedelta(days=1)
date = day.isoformat()

cfg = call("GET", "/api/worker/config")
print(f"   config: {len(cfg['groups'])} groups, {len(cfg['sources'])} sources, {len(cfg['handles'])} handles, {len(cfg['glossary'])} glossary")
locks = [g["locked"] for g in cfg["glossary"]]
check(locks == sorted(locks, reverse=True), "glossary lists locked terms first")
src = {s["name"]: s for s in cfg["sources"]}
dawn, bbc, geo = src["Dawn"], src["BBC Urdu"], src["Geo News"]
run = call("POST", "/api/worker/runs", {"kind": "edition", "date": date, "slot": "subh"})
rid = run["id"]

def item(s, path, title, text, lang="en", hours=2):
    url = f"https://example.org/smoke/{rid}/{path}"
    return {"source_id": s["id"], "url": url, "url_canonical": f"example.org/smoke/{rid}/{path}", "title": title, "text": text,
            "published_at": (now - dt.timedelta(hours=hours)).isoformat(), "lang": lang, "content_hash": hashlib.sha256(url.encode()).hexdigest()}
batch = [
    item(dawn, "imf-1", "IMF board approves tranche after review", "The IMF executive board approved the release of the next tranche on Monday, the finance ministry said.", hours=3),
    item(geo, "imf-2", "IMF releases $1bn tranche, PM hails 'confidence in economy'", "The prime minister said the approval reflected confidence in the government's reforms.", hours=2),
    item(bbc, "imf-3", "آئی ایم ایف نے قسط جاری کر دی", "آئی ایم ایف کے بورڈ نے پیر کو قسط کی منظوری دی۔", lang="ur", hours=1),
]
items = call("POST", "/api/worker/items", {"run_id": rid, "items": batch})
ids = {i["url_canonical"]: i["id"] for i in items["items"]}
key = lambda path: f"example.org/smoke/{rid}/{path}"
check(all(i["is_new"] for i in items["items"]), "new items are is_new")
again = call("POST", "/api/worker/items", {"run_id": rid, "items": [{**batch[0], "title": "EDITED headline", "text": "edited"}]})
check(again["items"][0]["id"] == ids[key("imf-1")] and again["items"][0]["is_new"], "a retried batch keeps ids and is_new")
check(again["items"][0].get("stored", {}).get("title") == batch[0]["title"], "an existing item comes back with the title first stored")
seen = call("GET", "/api/worker/items?" + urllib.parse.urlencode({"since": (now - dt.timedelta(minutes=10)).isoformat(), "group": "pakistan"}))
check(any(i["id"] == ids[key("imf-1")] and i["title"] == batch[0]["title"] for i in seen["items"]), "an existing item's title is never overwritten")
call("POST", "/api/worker/items", {"run_id": rid, "items": [{**batch[0], "source_id": 999999, "url_canonical": key("ghost")}]}, expect=(400,))

pid_x = f"17{rid:017d}"
post_x = {"platform": "x", "platform_id": pid_x, "author_handle": "HamidMirPAK", "author_name": "Hamid Mir",
    "text": "IMF board approval is in. Now watch the petrol price notification tonight.", "url": f"https://x.com/HamidMirPAK/status/{pid_x}",
    "posted_at": (now - dt.timedelta(hours=1)).isoformat(), "is_repost": False}
posts = call("POST", "/api/worker/posts", {"run_id": rid, "posts": [post_x]})
pid = posts["posts"][0]["id"]; print("   post handle_id:", posts["posts"][0]["handle_id"])
recent = call("GET", "/api/worker/posts?" + urllib.parse.urlencode({"since": (now - dt.timedelta(hours=6)).isoformat(), "group": "pakistan"}))
print("   recent posts in pakistan:", len(recent["posts"]))

story = {
    "order": 0, "thread": "imf-review-smoke", "thread_title_en": "IMF programme review", "thread_title_ur": "آئی ایم ایف پروگرام کا جائزہ",
    "title_en": "IMF board approves next tranche for Pakistan", "title_ur": "آئی ایم ایف بورڈ نے پاکستان کے لیے اگلی قسط منظور کر لی",
    "summary_en": "The IMF executive board approved the release of the next tranche on Monday, the finance ministry said. The prime minister called it a sign of confidence in the government's reforms.",
    "summary_ur": "وزارتِ خزانہ کے مطابق آئی ایم ایف کے ایگزیکٹو بورڈ نے پیر کو اگلی قسط جاری کرنے کی منظوری دی۔ وزیرِاعظم نے اسے حکومتی اصلاحات پر اعتماد کا اظہار قرار دیا۔",
    "why_en": "The tranche keeps reserves above three months of imports before the autumn debt repayments.", "why_ur": "یہ قسط خزاں میں قرضوں کی ادائیگی سے پہلے ذخائر کو تین ماہ کی درآمدات سے اوپر رکھتی ہے۔",
    "tag": "must-read", "coverage": "broad", "contested_en": "Geo quotes the tranche as $1bn; Dawn does not give a figure.", "contested_ur": "جیو نے قسط ایک ارب ڈالر بتائی ہے؛ ڈان نے رقم نہیں لکھی۔",
    "angles": [{"item_id": ids[key("imf-2")], "note_en": "Frames it as a political win for the PM", "note_ur": "اسے وزیرِاعظم کی سیاسی کامیابی کے طور پر پیش کرتا ہے"}],
    "sources": [{"item_id": ids[key("imf-1")], "is_primary": True}, {"item_id": ids[key("imf-2")]}, {"item_id": ids[key("imf-3")]}],
    "posts": [pid], "qa_status": "verified", "qa_note": "",
    # research metadata (D5): the topic and entity pages below read these once the edition is published
    "keywords": ["IMF", "tranche"], "topics": ["economy"], "countries": ["pk"], "places": ["Islamabad"], "event_type": "agreement",
    "entities": [{"name_en": "International Monetary Fund", "name_ur": "آئی ایم ایف", "kind": "org", "role": "lender", "salience": 0.9}]}
lead = {"lead_en": "The IMF released the next tranche after its review.", "lead_ur": "آئی ایم ایف نے جائزے کے بعد اگلی قسط جاری کر دی۔", "item_count": 3}

# subh: full PUT with two groups, a partial PUT of one of them, then publish.
call("GET", f"/api/worker/editions/{date}/subh", expect=(404,))
ed = call("PUT", f"/api/worker/editions/{date}/subh", {"run_id": rid, "status": "draft", "groups": [
    {"group": "world", **lead, "stories": [{**story, "order": 0}]}, {"group": "pakistan", **lead, "stories": [story]}]})
print("   edition:", ed["edition_id"], "stories:", ed["stories"])
call("PUT", f"/api/worker/editions/{date}/subh", {"partial": True, "groups": [{"group": "world", "lead_en": "Partial rerun.", "stories": [story]}]})
got = call("GET", f"/api/worker/editions/{date}/subh")
check(got["status"] == "draft" and got["groups"] == ["pakistan", "world"], "partial PUT keeps other groups, in configured order")
call("PUT", f"/api/worker/editions/{date}/subh", {"groups": [{"group": "nope", "stories": []}]}, expect=(400,))
call("PUT", f"/api/worker/editions/{date}/subh", {"groups": [{"group": "pakistan", "stories": [{"order": 0, "title_en": "x", "summary_en": "y", "sources": [{"item_id": 999999}]}]}]}, expect=(400,))
call("PUT", f"/api/worker/editions/{date}/subh", {"groups": [{"group": "pakistan", "stories": [{**story, "topics": ["not-a-topic"]}]}]}, expect=(400,))
out = call("POST", f"/api/worker/runs/{rid}/outputs", {"outputs": [{"group": "pakistan", "stage": "curate", "model": "smoke", "tokens_in": 1, "tokens_out": 1, "cost_usd": 0, "output": {"smoke": True}}]}, expect=(201,))
check(len(out["ids"]) == 1, "a run output is stored")
call("POST", f"/api/worker/runs/{rid}/outputs", {"outputs": [{"group": "nope", "stage": "curate", "output": {}}]}, expect=(400,))
pub = call("POST", f"/api/worker/editions/{date}/subh/publish", {"notify": False})
check(pub["status"] == "published", "subh published")
check(call("PUT", f"/api/worker/editions/{date}/subh", {"groups": [{"group": "pakistan", "stories": []}]}, expect=(409,))["error"] == "edition is published", "PUT on a published edition is refused")
check(call("POST", f"/api/worker/editions/{date}/subh/publish", {"notify": False})["published_at"] == pub["published_at"], "publishing twice is a no-op")
call("POST", "/api/worker/posts", {"posts": [{**post_x, "text": "EDITED post", "author_name": "Renamed"}]})
mine = call("GET", "/api/worker/posts?" + urllib.parse.urlencode({"since": (now - dt.timedelta(hours=6)).isoformat(), "handle": "HamidMirPAK"}))
check(any(p["id"] == pid and p["text"] == post_x["text"] and p["author_name"] == post_x["author_name"] for p in mine["posts"]), "a cited post's text is never overwritten")

# dopahar: a flagged story holds the edition; the hold survives both a rerun and a worker publish.
call("PUT", f"/api/worker/editions/{date}/dopahar", {"run_id": rid, "groups": [{"group": "pakistan", **lead, "stories": [{**story, "qa_status": "flagged", "qa_note": "smoke"}]}]})
check(call("POST", f"/api/worker/editions/{date}/dopahar/publish", {"notify": False})["status"] == "review", "flagged edition goes to review")
check(call("PUT", f"/api/worker/editions/{date}/dopahar", {"groups": [{"group": "pakistan", **lead, "stories": [story]}]}, expect=(409,))["error"] == "edition is in review", "PUT on a held edition is refused")
check(call("POST", f"/api/worker/editions/{date}/dopahar/publish", {"force": True, "notify": False})["status"] == "review", "the worker cannot publish past a hold")

# runs: unknown source is a 400, model may be null, a replayed PATCH changes nothing.
finish = {"status": "ok", "model": None, "tokens_in": 10, "tokens_out": 5, "cost_usd": 0.001, "log": "smoke",
          "sources": [{"source_id": dawn["id"], "ok": True, "items": 2, "ms": 120}, {"source_id": geo["id"], "ok": False, "items": 0, "error": "timeout", "ms": 25000}]}
call("PATCH", f"/api/worker/runs/{rid}", {**finish, "sources": [{"source_id": 999999, "ok": True}]}, expect=(400,))
check("already" not in call("PATCH", f"/api/worker/runs/{rid}", finish), "run finished with model null")
check(call("PATCH", f"/api/worker/runs/{rid}", finish).get("already") is True, "a replayed PATCH is a no-op")
xr = call("POST", "/api/worker/runs", {"kind": "x_collect"})["id"]
call("PATCH", f"/api/worker/runs/{xr}", {"status": "ok", "model": None, "log": "smoke"})
sr = call("POST", "/api/worker/runs", {"kind": "edition", "date": date, "slot": "shaam"})["id"]
call("PATCH", f"/api/worker/runs/{sr}", {"status": "skipped", "log": "smoke: slot already published"})

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
plain = urllib.request.build_opener(NoRedirect)
def fetch(path, headers=None, data=None):
    req = urllib.request.Request(base + path, data=data, headers=headers or {}, method="POST" if data else "GET")
    try:
        with plain.open(req, timeout=120) as r: return r.status, r.headers, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.headers, e.read().decode()

# Sign in (the cookie is sent by hand: in production it is Secure, which urllib's cookie jar keeps from http://localhost).
cookie = {}
email, password = os.environ.get("SMOKE_EMAIL"), os.environ.get("SMOKE_PASSWORD")
if email and password:
    form = urllib.parse.urlencode({"email": email, "password": password, "locale": "en"}).encode()
    status, headers, _ = fetch("/api/auth/login", {"Content-Type": "application/x-www-form-urlencoded", "Origin": base}, form)
    jar = [c.split(";", 1)[0] for c in headers.get_all("Set-Cookie") or [] if c.startswith("tb_session=")]
    check(status == 303 and bool(jar) and jar[-1] != "tb_session=", f"signed in as {email}")
    cookie = {"Cookie": jar[-1]}

sid = next(s["id"] for s in ed["stories"] if s["group"] == "pakistan")  # the partial PUT replaced the world story
for path in [f"/en", f"/ur", f"/en/{date}/subh", f"/ur/{date}/subh", f"/en/story/{sid}", f"/ur/story/{sid}", "/en/archive", "/ur/section/pakistan", "/en/about",
             "/en/topic/economy", "/ur/entity/international-monetary-fund", "/en/does-not-exist"]:
    status, headers, html = fetch(path, cookie)
    if not cookie:
        where = headers.get("Location", "")
        ok = status in (307, 308) and "/login" in where
        print(f"{'OK ' if ok else 'FAIL'} GET {path} -> {status} {where} (signed out: sent to sign in)")
        if not ok: sys.exit(1)
        continue
    marks = [m for m in ["IMF board approves", "آئی ایم ایف بورڈ", 'dir="rtl"', "HamidMirPAK", "Dawn"] if m in html]
    print(f"{'OK ' if status in (200,404) else 'FAIL'} GET {path} -> {status} {len(html)}B {marks}")
print("smoke done")
