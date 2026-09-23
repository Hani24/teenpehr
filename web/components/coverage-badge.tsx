import { getTranslations } from "next-intl/server";

export async function CoverageBadge({ coverage, outletCount }: { coverage: "broad" | "partisan" | "single-source" | null; outletCount: number }) {
  const t = await getTranslations("coverage");
  const key = coverage ?? (outletCount > 1 ? "broad" : "single-source");
  const cls = key === "broad" ? "cov-broad" : key === "partisan" ? "cov-partisan" : "cov-single";
  return (
    <span className="meta inline-flex items-center" title={t(key)}>
      <i className={`cov ${cls}`} aria-hidden="true" />
      {t(key)}
    </span>
  );
}
