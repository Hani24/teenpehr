#!/usr/bin/env python3
"""End-to-end smoke test of the worker API against a running web app (default http://localhost:3000).
Creates a run, posts items and posts, upserts an edition for today's slot, publishes it, then fetches
the public pages in both locales. Reads WORKER_TOKEN from web/.env.local. Usage: python3 scripts/smoke.py [base_url]
"""
import datetime as dt, json, os, sys, urllib.request, urllib.error, urllib.parse, hashlib, pathlib, zoneinfo

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
env = dict(l.strip().split("=", 1) for l in pathlib.Path(".env.local").read_text().splitlines() if "=" in l and not l.startswith("#"))
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

now = dt.datetime.now(zoneinfo.ZoneInfo("Asia/Karachi"))
date = now.strftime("%Y-%m-%d"); slot = "subh" if now.hour < 12 else ("dopahar" if now.hour < 18 else "shaam")

call("GET", "/api/worker/health", auth=False, expect=(401,))
h = call("GET", "/api/worker/health")
cfg = call("GET", "/api/worker/config")
print(f"   config: {len(cfg['groups'])} groups, {len(cfg['sources'])} sources, {len(cfg['handles'])} handles, {len(cfg['glossary'])} glossary")
src = {s["name"]: s for s in cfg["sources"]}
dawn, bbc, geo = src["Dawn"], src["BBC Urdu"], src["Geo News"]
run = call("POST", "/api/worker/runs", {"kind": "edition", "date": date, "slot": slot})
rid = run["id"]
def item(s, path, title, text, lang="en", hours=2):
    url = f"https://example.org/{path}"
    return {"source_id": s["id"], "url": url, "url_canonical": f"example.org/{path}", "title": title, "text": text,
            "published_at": (now - dt.timedelta(hours=hours)).isoformat(), "lang": lang, "content_hash": hashlib.sha256(url.encode()).hexdigest()}
items = call("POST", "/api/worker/items", {"run_id": rid, "items": [
    item(dawn, "smoke/imf-1", "IMF board approves tranche after review", "The IMF executive board approved the release of the next tranche on Monday, the finance ministry said.", hours=3),
    item(geo, "smoke/imf-2", "IMF releases $1bn tranche, PM hails 'confidence in economy'", "The prime minister said the approval reflected confidence in the government's reforms.", hours=2),
    item(bbc, "smoke/imf-3", "آئی ایم ایف نے قسط جاری کر دی", "آئی ایم ایف کے بورڈ نے پیر کو قسط کی منظوری دی۔", lang="ur", hours=1),
]})
ids = {i["url_canonical"]: i["id"] for i in items["items"]}
print("   is_new:", [i["is_new"] for i in items["items"]])
posts = call("POST", "/api/worker/posts", {"run_id": rid, "posts": [{
    "platform": "x", "platform_id": "1700000000000000001", "author_handle": "HamidMirPAK", "author_name": "Hamid Mir",
    "text": "IMF board approval is in. Now watch the petrol price notification tonight.", "url": "https://x.com/HamidMirPAK/status/1700000000000000001",
    "posted_at": (now - dt.timedelta(hours=1)).isoformat(), "is_repost": False}]})
pid = posts["posts"][0]["id"]; print("   post handle_id:", posts["posts"][0]["handle_id"])
recent = call("GET", "/api/worker/posts?" + urllib.parse.urlencode({"since": (now - dt.timedelta(hours=6)).isoformat(), "group": "pakistan"}))
print("   recent posts in pakistan:", len(recent["posts"]))
ed = call("PUT", f"/api/worker/editions/{date}/{slot}", {"run_id": rid, "status": "draft", "groups": [{
    "group": "pakistan", "lead_en": "The IMF released the next tranche after its review.", "lead_ur": "آئی ایم ایف نے جائزے کے بعد اگلی قسط جاری کر دی۔", "item_count": 3,
    "stories": [{
        "order": 0, "thread": "imf-review-2026-09", "thread_title_en": "IMF programme review", "thread_title_ur": "آئی ایم ایف پروگرام کا جائزہ",
        "title_en": "IMF board approves next tranche for Pakistan", "title_ur": "آئی ایم ایف بورڈ نے پاکستان کے لیے اگلی قسط منظور کر لی",
        "summary_en": "The IMF executive board approved the release of the next tranche on Monday, the finance ministry said. The prime minister called it a sign of confidence in the government's reforms.",
        "summary_ur": "وزارتِ خزانہ کے مطابق آئی ایم ایف کے ایگزیکٹو بورڈ نے پیر کو اگلی قسط جاری کرنے کی منظوری دی۔ وزیرِاعظم نے اسے حکومتی اصلاحات پر اعتماد کا اظہار قرار دیا۔",
        "why_en": "The tranche keeps reserves above three months of imports before the autumn debt repayments.", "why_ur": "یہ قسط خزاں میں قرضوں کی ادائیگی سے پہلے ذخائر کو تین ماہ کی درآمدات سے اوپر رکھتی ہے۔",
        "tag": "must-read", "coverage": "broad", "contested_en": "Geo quotes the tranche as $1bn; Dawn does not give a figure.", "contested_ur": "جیو نے قسط ایک ارب ڈالر بتائی ہے؛ ڈان نے رقم نہیں لکھی۔",
        "angles": [{"item_id": ids["example.org/smoke/imf-2"], "note_en": "Frames it as a political win for the PM", "note_ur": "اسے وزیرِاعظم کی سیاسی کامیابی کے طور پر پیش کرتا ہے"}],
        "sources": [{"item_id": ids["example.org/smoke/imf-1"], "is_primary": True}, {"item_id": ids["example.org/smoke/imf-2"]}, {"item_id": ids["example.org/smoke/imf-3"]}],
        "posts": [pid], "qa_status": "verified", "qa_note": ""}]}]})
print("   edition:", ed["edition_id"], "stories:", ed["stories"])
call("PUT", f"/api/worker/editions/{date}/{slot}", {"groups": [{"group": "nope", "stories": []}]}, expect=(400,))
call("PUT", f"/api/worker/editions/{date}/{slot}", {"groups": [{"group": "pakistan", "stories": [{"order": 0, "title_en": "x", "summary_en": "y", "sources": [{"item_id": 999999}]}]}]}, expect=(400,))
pub = call("POST", f"/api/worker/editions/{date}/{slot}/publish", {})
print("   published:", pub)
call("PUT", f"/api/worker/editions/{date}/{slot}", {"groups": [{"group": "pakistan", "stories": []}]}, expect=(409,))
call("PATCH", f"/api/worker/runs/{rid}", {"status": "ok", "model": "smoke", "tokens_in": 10, "tokens_out": 5, "cost_usd": 0.001, "log": "smoke", "sources": [{"source_id": dawn["id"], "ok": True, "items": 2, "ms": 120}, {"source_id": geo["id"], "ok": False, "items": 0, "error": "timeout", "ms": 25000}]})
for path in [f"/en", f"/ur", f"/en/{date}/{slot}", f"/ur/{date}/{slot}", f"/en/story/{ed['stories'][0]['id']}", f"/ur/story/{ed['stories'][0]['id']}", "/en/archive", "/ur/section/pakistan", "/en/about", "/en/does-not-exist"]:
    req = urllib.request.Request(base + path)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: status, html = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, html = e.code, e.read().decode()
    marks = [m for m in ["IMF board approves", "آئی ایم ایف بورڈ", 'dir="rtl"', "HamidMirPAK", "Dawn"] if m in html]
    print(f"{'OK ' if status in (200,404) else 'FAIL'} GET {path} -> {status} {len(html)}B {marks}")
print("smoke done")
