import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getSitePrefs } from "@/lib/queries";
import type { Locale } from "@/lib/urdu";

/**
 * The site-wide disclosure: the admin's text (Settings), with the shipped wording as the fallback. Since D14 it
 * makes no claim about any one story (no "written by AI", no "reviewed by an editor" for all of them): each
 * story carries its own line (components/review-badge.tsx, components/manual-badge.tsx).
 */
export async function disclosureText(locale: Locale): Promise<string> {
  const [prefs, ts] = await Promise.all([getSitePrefs(), getTranslations({ locale, namespace: "site" })]);
  return (locale === "ur" ? prefs.disclosureUr : prefs.disclosureEn) || ts("disclosure");
}

export async function SiteFooter({ locale }: { locale: Locale }) {
  // Signed out (the sign-in pages), the links would only lead back to sign in.
  const user = await getCurrentUser();
  const t = await getTranslations("footer");
  const ts = await getTranslations("site");
  const ta = await getTranslations("about");
  const tacc = await getTranslations("account");
  const tr = await getTranslations("review");
  const [disclosure, prefs] = await Promise.all([disclosureText(locale), getSitePrefs()]);
  const editor = prefs.editorName;
  return (
    <footer className="no-print mt-16 border-t border-rule bg-surface-2">
      <div className="ui mx-auto max-w-6xl px-[var(--gutter)] py-8 text-[length:var(--step--1)] text-ink-2">
        <p className="measure" data-site-disclosure="">{disclosure}</p>
        {/* The editor in charge (Settings), named without claiming they reviewed every story (D14). */}
        {editor && <p className="measure mt-2">{tr.rich("editorInCharge", { name: editor, n: (c) => <bdi className={/[؀-ۿ]/.test(editor) ? undefined : "latin"}>{c}</bdi> })}</p>}
        {user && (
          <div className="ui mt-4 flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/about">{ta("title")}</Link>
            {/* The feeds are private (D2): each account has its own links, made on the account page. */}
            <Link href="/account#feed">{tacc("feedTitle")} ({t("rss")}, {t("json")})</Link>
          </div>
        )}
        <p className="mt-4">{ts("name")} · {t("madeBy")}</p>
      </div>
    </footer>
  );
}
