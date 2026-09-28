import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/lib/urdu";
import { AcceptLink } from "@/components/accept-link";

export async function generateMetadata({ params }: PageProps<"/[locale]/invite/[token]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "auth" });
  // The token is in this page's URL: never send it to another site as a Referer. ("no-referrer"
  // would also turn the form post's Origin into "null", which the CSRF check refuses.)
  return { title: t("inviteTitle"), robots: { index: false, follow: false }, referrer: "same-origin" };
}

/** An invite link: choose a name and password to create the account (decision D2). */
export default async function InvitePage({ params, searchParams }: PageProps<"/[locale]/invite/[token]">) {
  const { locale, token } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const error = (await searchParams).error;
  return <AcceptLink kind="invite" token={token} locale={(isLocale(locale) ? locale : "en") as Locale} error={typeof error === "string" ? error : ""} />;
}
