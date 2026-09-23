"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function BackToTop() {
  const t = useTranslations("nav");
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight * 1.5);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!show) return null;
  return (
    <button type="button" onClick={() => window.scrollTo({ top: 0 })} className="no-print fixed bottom-4 end-4 z-40 rounded-full border border-rule bg-surface px-4 py-3 shadow-md ui font-semibold hover:border-rule-strong">
      ↑ {t("backToTop")}
    </button>
  );
}
