import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import type { Locale } from "@/lib/urdu";
import { MenuDetails } from "./menu-details";

/**
 * The signed-in reader's menu in the masthead: who is signed in, their account page, the admin for
 * editors and owners, and sign out (a form post, so it works without JavaScript). A <details>
 * disclosure, so it needs no script either. Renders nothing when signed out (the sign-in pages).
 *
 * On narrow screens the chip can sit mid-row, so the panel is placed against the page's inline end
 * (the nearest positioned box is the page) instead of under the chip; from `sm` up it hangs from the chip.
 */
export async function AccountMenu({ locale }: { locale: Locale }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const t = await getTranslations("account");
  const who = user.name || user.email;
  return (
    <MenuDetails className="no-print sm:relative">
      <summary className="chip cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden" aria-label={t("menuLabel", { name: who })}>
        <span aria-hidden="true" className="inline-flex h-[1.5em] w-[1.5em] items-center justify-center rounded-full bg-accent text-[0.8em] text-accent-ink">
          {[...who.trim()][0]?.toUpperCase() ?? "?"}
        </span>
        {t("menu")}
      </summary>
      <div className="card absolute end-[var(--gutter)] z-40 mt-2 w-72 max-w-[calc(100vw-2*var(--gutter))] p-4 shadow-lg sm:end-0">
        <p className="meta">{t("signedInAs")}</p>
        {/* The email may break anywhere (never truncated: in Urdu the ellipsis would eat its start); a name wraps as words. */}
        <p className="ui font-semibold">{user.name ? <bdi>{who}</bdi> : <bdi className="latin wrap-anywhere!">{who}</bdi>}</p>
        {user.name && <p className="meta"><bdi className="latin wrap-anywhere!">{user.email}</bdi></p>}
        <ul className="ui mt-3 space-y-1">
          <li><Link href="/account" className="block rounded px-2 py-2 no-underline hover:bg-surface-2 hover:underline">{t("title")}</Link></li>
          {roleAtLeast(user.role, "editor") && (
            <li><NextLink href="/admin" className="block rounded px-2 py-2 no-underline hover:bg-surface-2 hover:underline">{t("admin")}</NextLink></li>
          )}
        </ul>
        <form method="post" action="/api/auth/logout" className="mt-3 border-t border-rule pt-3">
          <input type="hidden" name="locale" value={locale} />
          <button type="submit" className="chip w-full cursor-pointer justify-center font-semibold">{t("signOut")}</button>
        </form>
      </div>
    </MenuDetails>
  );
}
