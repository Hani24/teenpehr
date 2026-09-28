"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { TARGET } from "@/components/save-button";

/** Opens the browser's print window, where the reader chooses "Save as PDF", once the fonts and pictures are in. */
export function PrintButton({ urdu }: { urdu: boolean }) {
  const t = useTranslations("download");
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      // Urdu headlines use a Nastaliq face with font-display: block (see the print page); printing
      // before it arrives would leave them blank. Never wait more than a few seconds.
      const loads: Promise<unknown>[] = [document.fonts.ready];
      if (urdu) loads.push(document.fonts.load('600 24px "Tabayyun Print Nastaliq"', "تبیُّن"));
      // Story pictures (loaded eagerly on this page): print once they are in, or failed.
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(".print-doc img"))) {
        if (!img.complete) loads.push(new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }));
      }
      await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      // print with whatever has loaded
    }
    setBusy(false);
    window.print();
  };
  return (
    <button type="button" onClick={onClick} aria-busy={busy} className={`chip ui cursor-pointer font-semibold ${TARGET} !border-accent !bg-accent !text-accent-ink`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0">
        <path d="M7 9V3.5h10V9M7 17H4.5V10a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v7H17M7 14h10v6.5H7z" />
      </svg>
      {busy ? t("printing") : t("printButton")}
    </button>
  );
}
