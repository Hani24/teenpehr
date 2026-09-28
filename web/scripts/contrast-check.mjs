#!/usr/bin/env node
/*
 * WCAG 2.2 contrast check for every reader palette (decision D4 in docs/PLAN.md).
 *
 *   node scripts/contrast-check.mjs            # table of the lowest ratio per palette and state; exit 1 on a failure
 *   node scripts/contrast-check.mjs --verbose  # every pair
 *
 * Reads the colour tokens from app/globals.css and models their cascade: the :root block (Classic), the
 * `:root[data-theme="<id>"]` palette blocks, the `[data-contrast="high"]` overrides and the
 * `@media (prefers-color-scheme: dark)` blocks that make "system" Night on a dark device. Every palette is
 * checked in four states (normal and high contrast, on a light and a dark device) against:
 *   text  4.5:1 (AA), 7:1 with high contrast (AAA; the Wazeh mode's high-contrast promise);
 *   ui    3:1 for focus rings, coverage dots and selected borders (1.4.11).
 * The text pairs are the ones actually used: every `text-<token>`/`bg-<token>` utility in app/ and
 * components/ (a text token with a background in the same class string is checked on that background,
 * otherwise on every page background), and every rule in globals.css that sets `color: var(--token)`.
 * It also checks that "system" really is Classic on a light device and Night on a dark one, and that each
 * palette's `bg` in lib/view.ts (the browser bar colour) matches its --bg.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");

/** Tailwind colour name (@theme in globals.css) -> CSS token. */
const UTILITY_TOKEN = {
  paper: "bg", surface: "surface", "surface-2": "surface-2", ink: "ink", "ink-2": "ink-2", "ink-3": "ink-3", rule: "rule",
  "rule-strong": "rule-strong", accent: "accent", "accent-ink": "accent-ink", link: "link", focus: "focus", ok: "ok", warn: "warn",
};
const TOKENS = new Set(Object.values(UTILITY_TOKEN));
const PAGE_BGS = ["bg", "surface", "surface-2"];
/** Non-text pairs (3:1), which no class string reveals. */
const UI_PAIRS = [
  ...PAGE_BGS.map((b) => ["focus", b, "focus ring (:focus-visible)"]),
  ...["ok", "warn", "ink-3"].flatMap((f) => ["bg", "surface"].map((b) => [f, b, "coverage dot (.cov)"])),
  ...PAGE_BGS.map((b) => ["rule-strong", b, "selected chip and option border"]),
];

// ---- CSS parsing ------------------------------------------------------------------------------
/** Top-level rules as {prelude, body}, @-statements without a body skipped. */
function rules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    let j = i;
    while (j < src.length && src[j] !== "{" && src[j] !== ";" && src[j] !== "}") j++;
    if (j >= src.length) break;
    const prelude = src.slice(i, j).trim();
    if (src[j] !== "{") { i = j + 1; continue; }
    let depth = 1, k = j + 1;
    while (k < src.length && depth) { if (src[k] === "{") depth++; else if (src[k] === "}") depth--; k++; }
    out.push({ prelude, body: src.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}
function declarations(body) {
  const out = new Map();
  for (const part of body.split(";")) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1].slice(2), m[2]);
  }
  return out;
}
/** `:root`, `:root[data-theme="x"]`, either with `[data-contrast="high"]`; swatch selectors are recognised and ignored. */
function classify(sel) {
  if (/^\[data-swatch="[a-z]+"\]$/.test(sel)) return { swatch: true };
  const m = /^:root(\[data-theme="([a-z]+)"\])?(\[data-contrast="high"\])?$/.exec(sel);
  return m ? { theme: m[2] ?? null, high: !!m[3], spec: 1 + (m[1] ? 1 : 0) + (m[3] ? 1 : 0) } : null;
}

const cssPath = join(web, "app/globals.css");
const cssSrc = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const errors = [];
const blocks = [];
const cssRules = [];
(function walk(src, media) {
  for (const { prelude, body } of rules(src)) {
    if (prelude.startsWith("@media")) {
      const q = prelude.slice(6).trim();
      if (/^print$/.test(q) || /prefers-reduced-motion/.test(q)) continue; // not a palette
      if (q !== "(prefers-color-scheme: dark)") { if (/--(bg|ink|surface)/.test(body)) errors.push(`colour tokens under an unmodelled @media ${q}`); continue; }
      walk(body, "dark");
    } else if (prelude.startsWith("@layer")) walk(body, media);
    else if (prelude.startsWith("@")) continue; // @theme maps tokens to utilities, it defines none
    else {
      cssRules.push({ prelude, body });
      const decls = declarations(body);
      const colours = [...decls].filter(([k]) => TOKENS.has(k));
      if (!colours.length) continue;
      for (const sel of prelude.split(",").map((s) => s.trim())) {
        const c = classify(sel);
        if (!c) { errors.push(`colour tokens under a selector the checker cannot model: ${sel}`); continue; }
        if (!c.swatch) blocks.push({ ...c, dark: media === "dark", index: blocks.length, sel, decls: new Map(colours) });
      }
    }
  }
})(cssSrc, null);

// Palettes in lib/view.ts order (PALETTE_DEFS, whose `bg` is checked below), then any the CSS adds.
const view = readFileSync(join(web, "lib/view.ts"), "utf8");
const defs = [...view.matchAll(/^\s*([a-z]+): \{ scheme: "(light|dark|auto)", bg: "(#[0-9a-f]{6})" \}/gm)];
const palettes = [...new Set([...defs.map(([, id]) => id), "classic", "system", ...blocks.map((b) => b.theme).filter(Boolean)])];

/** The colour tokens in effect for a palette, contrast and device scheme: matching blocks by specificity, then source order. */
function tokensFor(theme, high, dark) {
  const matching = blocks.filter((b) => (b.theme === null || b.theme === theme) && (!b.high || high) && (!b.dark || dark))
    .sort((a, b) => a.spec - b.spec || a.index - b.index);
  const raw = new Map();
  for (const b of matching) for (const [k, v] of b.decls) raw.set(k, v);
  const resolved = new Map();
  const resolve = (k, seen = new Set()) => {
    if (resolved.has(k)) return resolved.get(k);
    const v = raw.get(k);
    if (v === undefined) return null;
    const ref = /^var\(--([\w-]+)\)$/.exec(v);
    const out = ref ? (seen.has(ref[1]) ? null : resolve(ref[1], new Set([...seen, k]))) : parseColour(v);
    resolved.set(k, out);
    return out;
  };
  for (const k of TOKENS) {
    const c = resolve(k);
    if (!c) errors.push(`${theme}${high ? " high" : ""}${dark ? " dark" : ""}: --${k} is missing or not a colour (${raw.get(k)})`);
  }
  return resolved;
}

// ---- colour maths (WCAG 2.2 relative luminance) -------------------------------------------------
function parseColour(v) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/i.exec(v.trim());
  return m ? m.slice(1, 4).map(Number) : null;
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const hex = (c) => "#" + c.map((n) => n.toString(16).padStart(2, "0")).join("");

// ---- the text pairs actually used ---------------------------------------------------------------
const textPairs = new Map(); // "fg|bg" -> first place seen
const addText = (fg, bgs, where) => { for (const b of bgs) if (fg !== b && !textPairs.has(`${fg}|${b}`)) textPairs.set(`${fg}|${b}`, where); };

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}
const utility = /(?:^|[\s"'`:!])(text|bg)-(paper|surface-2|surface|ink-3|ink-2|ink|rule-strong|rule|accent-ink|accent|link|focus|ok|warn)(?![\w-])/g;
for (const file of ["app", "components"].flatMap((d) => sourceFiles(join(web, d)))) {
  const src = readFileSync(file, "utf8");
  for (const lit of src.match(/"[^"\n]*"|`[^`]*`|'[^'\n]*'/g) ?? []) {
    const fgs = new Set(), bgs = new Set();
    for (const m of lit.matchAll(utility)) (m[1] === "text" ? fgs : bgs).add(UTILITY_TOKEN[m[2]]);
    for (const fg of fgs) addText(fg, bgs.size ? [...bgs] : PAGE_BGS, relative(web, file));
  }
}
for (const { prelude, body } of cssRules) {
  const fg = /(?:^|;)\s*color\s*:\s*var\(--([\w-]+)\)/.exec(body)?.[1];
  if (!fg || !TOKENS.has(fg)) continue;
  const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--([\w-]+)\)/.exec(body)?.[1];
  addText(fg, bg && TOKENS.has(bg) ? [bg] : PAGE_BGS, `globals.css ${prelude.slice(0, 40)}`);
}

// ---- check -----------------------------------------------------------------------------------------
const states = [];
// Only "system" follows the device; the others are checked to be the same on both (below).
for (const p of palettes) for (const high of [false, true]) for (const dark of p === "system" ? [false, true] : [false]) states.push({ p, high, dark });
const rows = [];
const failures = [];
for (const s of states) {
  const t = tokensFor(s.p, s.high, s.dark);
  const label = `${s.p}${s.high ? " +high contrast" : ""}${s.dark ? " (dark device)" : ""}`;
  let minText = Infinity, minUi = Infinity;
  const check = (fg, bg, min, kind, where) => {
    const a = t.get(fg), b = t.get(bg);
    if (!a || !b) return;
    const r = ratio(a, b);
    if (kind === "text") minText = Math.min(minText, r); else minUi = Math.min(minUi, r);
    const bad = r < min;
    if (bad) failures.push(`${label}: --${fg} ${hex(a)} on --${bg} ${hex(b)} = ${r.toFixed(2)}:1, needs ${min}:1 (${kind}; ${where})`);
    if (verbose) console.log(`${bad ? "FAIL" : "ok  "} ${label.padEnd(40)} ${kind.padEnd(4)} ${fg.padEnd(11)} on ${bg.padEnd(9)} ${r.toFixed(2).padStart(5)}:1  (${where})`);
  };
  for (const [key, where] of textPairs) { const [fg, bg] = key.split("|"); check(fg, bg, s.high ? 7 : 4.5, "text", where); }
  for (const [fg, bg, where] of UI_PAIRS) check(fg, bg, 3, "ui", where);
  rows.push({ label, bg: t.get("bg") ? hex(t.get("bg")) : "?", minText, minUi, high: s.high });
}

// "system" must be Classic by day and Night on a dark device, in both contrasts.
const same = (a, b) => [...TOKENS].every((k) => a.get(k) && b.get(k) && hex(a.get(k)) === hex(b.get(k)));
for (const high of [false, true]) {
  if (!same(tokensFor("system", high, false), tokensFor("classic", high, false))) errors.push(`system${high ? " +high contrast" : ""} on a light device is not Classic`);
  if (!same(tokensFor("system", high, true), tokensFor("night", high, false))) errors.push(`system${high ? " +high contrast" : ""} on a dark device is not Night`);
}
// Concrete palettes must not follow the device.
for (const p of palettes.filter((x) => x !== "system")) for (const high of [false, true]) {
  if (!same(tokensFor(p, high, false), tokensFor(p, high, true))) errors.push(`${p} changes on a dark device; only "system" may`);
}

// lib/view.ts: each palette's `bg` (browser bar colour) is its --bg.
if (!defs.length) errors.push("lib/view.ts: no palette definitions found (PALETTE_DEFS)");
for (const [, id, , bg] of defs) {
  const want = tokensFor(id, false, false).get("bg");
  if (!want) errors.push(`lib/view.ts: palette ${id} has no token block in globals.css`);
  else if (hex(want) !== bg.toLowerCase()) errors.push(`lib/view.ts: ${id} bg ${bg} but globals.css --bg is ${hex(want)}`);
}
for (const p of palettes) if (!defs.some(([, id]) => id === p)) errors.push(`globals.css palette ${p} is missing from PALETTE_DEFS in lib/view.ts`);

// ---- report ------------------------------------------------------------------------------------------
console.log(`${textPairs.size} text pairs in use, ${UI_PAIRS.length} ui pairs, ${palettes.length} palettes (${palettes.join(", ")})\n`);
console.log(`${"palette".padEnd(44)}${"--bg".padEnd(10)}${"min text".padStart(9)}${"min ui".padStart(9)}  needs`);
for (const r of rows) console.log(`${r.label.padEnd(44)}${r.bg.padEnd(10)}${r.minText.toFixed(2).padStart(9)}${r.minUi.toFixed(2).padStart(9)}  ${r.high ? "7 / 3" : "4.5 / 3"}`);
const problems = [...errors, ...failures];
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("\nAll palettes pass (text AA 4.5:1, high contrast AAA 7:1, ui 3:1).");
