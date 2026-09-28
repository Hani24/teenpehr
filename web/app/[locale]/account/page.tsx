import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import NextLink from "next/link";
import { and, desc, eq, gt } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { db, schema } from "@/db";
import { Link } from "@/i18n/navigation";
import { getSessionToken, requireUser, roleAtLeast } from "@/lib/auth";
import { hashToken, looksLikeToken } from "@/lib/auth/tokens";
import { getSitePrefs } from "@/lib/queries";
import { formatDate, isLocale, type Locale } from "@/lib/urdu";
import { FEED_TOKEN_COOKIE } from "@/app/api/auth/_lib";
import { AuthPanel, Notice, Section, SubmitButton, TextField } from "@/components/auth-ui";
import { CopyField } from "@/components/copy-field";
import { PasswordInput } from "@/components/password-input";

export async function generateMetadata({ params }: PageProps<"/[locale]/account">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "account" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

const OKS = ["password", "password_reset", "profile", "feed_new", "feed_revoked"] as const;
const ERRORS = ["current_wrong", "rate_limited", "bad_request", "name_too_long"] as const;
const PROBLEMS = ["too_short", "too_long", "common", "same_as_email", "mismatch"] as const;

/** Browser and system from a user agent, for the device list ("Firefox · Linux"). Names are not translated. */
function deviceOf(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ");
}

/**
 * The reader's own account (decision D2): name, password, private feed link, signed-in devices. All
 * forms post to /api/auth/*. Display preferences (palette, Wazeh mode) are saved through updatePrefs
 * from the theme controls, not here.
 */
export default async function AccountPage({ params, searchParams }: PageProps<"/[locale]/account">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const l = (isLocale(locale) ? locale : "en") as Locale;
  const user = await requireUser({ locale: l, next: `/${l}/account` });
  const [t, ta, tn, sp, prefs, raw, jar] = await Promise.all([
    getTranslations("account"), getTranslations("auth"), getTranslations("nav"), searchParams, getSitePrefs(), getSessionToken(), cookies(),
  ]);
  const { users, sessions } = schema;
  const [[row], devices] = await Promise.all([
    db.select({ createdAt: users.createdAt, feedHash: users.feedTokenHash }).from(users).where(eq(users.id, user.id)),
    db.select({ id: sessions.id, ua: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt }).from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date()))).orderBy(desc(sessions.lastSeenAt)).limit(20),
  ]);
  const currentId = raw ? hashToken(raw) : "";
  const date = (d: Date) => formatDate(d, l, { dateStyle: "medium", timeStyle: "short", hourCycle: l === "ur" ? "h23" : "h12" }, prefs.digitsUr);

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const ok = OKS.find((o) => o === one(sp.ok));
  const errCode = one(sp.error);
  const problem = PROBLEMS.find((p) => p === errCode);
  const error = problem ? ta(`problem.${problem}`) : ERRORS.find((e) => e === errCode) ? t(`errors.${errCode as (typeof ERRORS)[number]}`) : "";
  // The raw token exists only in the cookie the feed-token route just set (two minutes, this page
  // only); it is shown only while it is still the account's current one.
  const flashed = ok === "feed_new" ? jar.get(FEED_TOKEN_COOKIE)?.value : undefined;
  const hasFeed = !!row?.feedHash;
  const feedToken = looksLikeToken(flashed) && hashToken(flashed) === row?.feedHash ? flashed : "";
  const site = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const feeds = feedToken ? (["en", "ur"] as const).flatMap((fl) => (["xml", "json"] as const).map((ext) => ({
    label: `${fl === "en" ? t("feedEn") : t("feedUr")} · ${ext === "xml" ? "RSS" : "JSON Feed"}`,
    url: `${site}/${fl}/feed.${ext}?token=${feedToken}`,
  }))) : [];

  // The email may break anywhere so a long one never widens a phone screen; marked important (!)
  // because globals.css sets overflow-wrap: normal on :lang(ur) outside any layer.
  return (
    <AuthPanel title={t("title")} wide lead={<p>{t("signedInAs")} <bdi className="latin font-semibold wrap-anywhere!">{user.email}</bdi></p>}>
      {ok && ok !== "feed_new" && <Notice tone="ok">{t(`ok.${ok}`)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {roleAtLeast(user.role, "editor") && (
        <p className="mb-2"><NextLink href="/admin" className="chip">{t("admin")}</NextLink></p>
      )}

      <Section id="profile" title={t("profile")}>
        {/* Label above value on a phone (a long email needs the whole width), side by side from `sm` up. */}
        <dl className="grid gap-x-4 sm:grid-cols-[auto_1fr] sm:gap-y-2 [&>dd:not(:last-child)]:max-sm:mb-2">
          <dt className="meta">{t("email")}</dt><dd className="min-w-0"><bdi className="latin wrap-anywhere!">{user.email}</bdi></dd>
          <dt className="meta">{t("role")}</dt><dd>{t(`roles.${user.role}`)}</dd>
          {row && <><dt className="meta">{t("memberSince")}</dt><dd>{formatDate(row.createdAt, l, { dateStyle: "long" }, prefs.digitsUr)}</dd></>}
        </dl>
        <form method="post" action="/api/auth/profile" className="mt-4">
          <input type="hidden" name="locale" value={l} />
          <TextField id="name" name="name" label={t("name")} defaultValue={user.name} autoComplete="name" dir="auto" maxLength={100} />
          <SubmitButton tone="plain" full={false}>{t("saveName")}</SubmitButton>
        </form>
      </Section>

      <Section id="password" title={t("passwordTitle")}>
        <p className="text-ink-2">{t("passwordNote")}</p>
        <form method="post" action="/api/auth/password" className="mt-4">
          <input type="hidden" name="locale" value={l} />
          {/* For password managers: which account this new password belongs to. */}
          <input type="email" name="username" value={user.email} autoComplete="username" readOnly hidden />
          <PasswordInput name="current" label={t("currentPassword")} showLabel={ta("showPassword")} autoComplete="current-password" required maxLength={1000} />
          <PasswordInput name="password" label={t("newPassword")} hint={ta("passwordHint")} showLabel={ta("showPassword")} autoComplete="new-password" required minLength={10} maxLength={200} />
          <PasswordInput name="confirm" label={t("confirmPassword")} showLabel={ta("showPassword")} autoComplete="new-password" required minLength={10} maxLength={200} />
          <SubmitButton full={false}>{t("changePassword")}</SubmitButton>
        </form>
      </Section>

      <Section id="feed" title={t("feedTitle")}>
        <p className="measure text-ink-2">{t("feedLead")}</p>
        {feeds.length > 0 ? (
          <div className="mt-4">
            <Notice tone="ok">{t("feedNew")}</Notice>
            {feeds.map((f) => <CopyField key={f.url} label={f.label} value={f.url} copyLabel={t("copy")} copiedLabel={t("copied")} />)}
          </div>
        ) : (
          <p className="mt-4 font-semibold">{hasFeed ? t("feedActive") : t("feedNone")}</p>
        )}
        <div className="flex flex-wrap gap-x-3">
          <form method="post" action="/api/auth/feed-token">
            <input type="hidden" name="locale" value={l} />
            <input type="hidden" name="action" value="rotate" />
            <SubmitButton tone="plain" full={false}>{hasFeed ? t("feedRotate") : t("feedCreate")}</SubmitButton>
          </form>
          {hasFeed && (
            <form method="post" action="/api/auth/feed-token">
              <input type="hidden" name="locale" value={l} />
              <input type="hidden" name="action" value="revoke" />
              <SubmitButton tone="danger" full={false}>{t("feedRevoke")}</SubmitButton>
            </form>
          )}
        </div>
      </Section>

      <Section id="devices" title={t("devicesTitle")}>
        <ul className="divide-y divide-rule">
          {devices.map((d) => (
            <li key={d.id} className="py-3 first:pt-0">
              <p className="font-semibold">
                <bdi className="latin">{deviceOf(d.ua) || t("unknownDevice")}</bdi>
                {d.id === currentId && <span className="pill pill-soft ms-2">{t("thisDevice")}</span>}
              </p>
              <p className="meta">{t("lastActive")}: {date(d.lastSeenAt)} · {t("signedInAt")}: {date(d.createdAt)}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-x-3">
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="locale" value={l} />
            <SubmitButton tone="plain" full={false}>{t("signOut")}</SubmitButton>
          </form>
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="locale" value={l} />
            <input type="hidden" name="everywhere" value="1" />
            <SubmitButton tone="danger" full={false}>{t("signOutEverywhere")}</SubmitButton>
          </form>
        </div>
        <p className="meta mt-2">{t("signOutEverywhereNote")}</p>
      </Section>

      <p className="mt-8"><Link href="/" className="chip">{tn("today")}</Link></p>
    </AuthPanel>
  );
}
