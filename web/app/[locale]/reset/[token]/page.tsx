import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/lib/urdu";
import { AcceptLink } from "@/components/accept-link";

export async function generateMetadata({ params }: PageProps<"/[locale]/reset/[token]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "auth" });
  // The token is in this page's URL: never send it to another site as a Referer. ("no-referrer"
  // would also turn the form post's Origin into "null", which the CSRF check refuses.)
  return { title: t("resetTitle"), robots: { index: false, follow: false }, referrer: "same-origin" };
}

/** A password reset link from an owner: choose a new password (every session of the account ends). */
export default async function ResetPage({ params, searchParams }: PageProps<"/[locale]/reset/[token]">) {
  const { locale, token } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const error = (await searchParams).error;
  return <AcceptLink kind="reset" token={token} locale={(isLocale(locale) ? locale : "en") as Locale} error={typeof error === "string" ? error : ""} />;
}
