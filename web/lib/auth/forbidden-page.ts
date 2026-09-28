/*
 * The 403 page the proxy sends when a signed-in account lacks the role for an admin address (readers
 * on /admin, editors on /admin/users). Plain, self-contained HTML (no script, the site's own OFL
 * fonts), in both languages since the admin has no locale. Behind it, requireAdmin/requireOwner still
 * answer forbidden() (app/admin/forbidden.tsx) if a request ever reaches a page.
 */
const CSS = `
@font-face{font-family:"Inter Web";src:url("/fonts/InterVariable.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Vazirmatn Web";src:url("/fonts/Vazirmatn%5Bwght%5D.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#f7f3ec;--surface:#fffdf9;--ink:#1c1917;--ink-2:#57534e;--rule:#d9d1c4;--accent:#9a2f22}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--ink:#ece7de;--ink-2:#b4ada3;--rule:#2a2f3a;--accent:#e0b46a}}
html{background:var(--bg);color:var(--ink);font-family:"Inter Web",system-ui,sans-serif;font-size:18px;line-height:1.6}
body{margin:0}
main{max-inline-size:34rem;margin-inline:auto;padding:4rem 1rem}
.mark{font-weight:700;font-size:1.6rem;color:var(--accent)}
h1{font-size:1.4rem;line-height:1.3;margin-block:1rem .5rem}
p{margin-block:.5rem;color:var(--ink-2)}
[lang="ur"]{font-family:"Vazirmatn Web","Noto Naskh Arabic",sans-serif;line-height:1.9;letter-spacing:0}
section+section{border-block-start:1px solid var(--rule);margin-block-start:1.5rem;padding-block-start:1rem}
nav{display:flex;flex-wrap:wrap;gap:.75rem;margin-block-start:2rem}
a{display:inline-flex;align-items:center;min-block-size:3rem;padding-inline:1rem;border:2px solid var(--rule);border-radius:999px;background:var(--surface);color:var(--ink);font-weight:600;text-decoration:none}
a:hover{border-color:var(--ink)}
a:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}
`;

export function forbiddenHtml(): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Not for this account · Tabayyun</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="mark">Tabayyun <span lang="ur" dir="rtl">تبیُّن</span></div>
<section>
<h1>This page is for the newsroom</h1>
<p>Your account can read the site but cannot use this part of the admin. If you should have access, ask the site's owner.</p>
</section>
<section lang="ur" dir="rtl">
<h1>یہ صفحہ نیوز روم کے لیے ہے</h1>
<p>آپ کا اکاؤنٹ سائٹ پڑھ سکتا ہے، انتظامیہ کا یہ حصہ استعمال نہیں کر سکتا۔ اگر آپ کو رسائی ملنی چاہیے تو سائٹ کے مالک سے بات کریں۔</p>
</section>
<nav>
<a href="/en">Back to the site</a>
<a href="/ur" lang="ur" dir="rtl">سائٹ پر واپس جائیں</a>
</nav>
</main>
</body>
</html>
`;
}
