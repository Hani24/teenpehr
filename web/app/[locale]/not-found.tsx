import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <div className="mx-auto max-w-2xl px-[var(--gutter)] py-24 text-center">
      <h1 className="headline text-[length:var(--step-2)]">{t("notFound")}</h1>
      <p className="mt-3 text-ink-2">{t("notFoundText")}</p>
      <p className="mt-6"><Link href="/" className="chip">{t("goHome")}</Link></p>
    </div>
  );
}
