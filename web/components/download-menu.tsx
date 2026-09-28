"use client";
import { useLocale, useTranslations } from "next-intl";
import { TARGET } from "./save-button";
import { imagesParam } from "./sw-register";

/** Adds this device's images choice to a download link as it is followed (a plain link without JavaScript). */
function withImages(e: React.MouseEvent<HTMLAnchorElement>) {
  const a = e.currentTarget;
  a.href = `${a.pathname}${imagesParam("?")}`;
}

/*
 * Download an edition (decision D3): a print page that saves as PDF, and one self-contained HTML
 * file. Two plain links rather than a pull-down, so nothing is hidden behind a hover or a tap. Plain
 * <a>, not <Link>: the print page is a document of its own (print.css, fonts that must be loaded
 * before printing), and the file is an attachment. No `download` attribute: the route's
 * Content-Disposition makes it a file, and if the session has ended the click must load the sign-in
 * page (which then returns to this page) rather than save that page as the file.
 */
export function DownloadMenu({ date, slot, className = "" }: { date: string; slot: string; className?: string }) {
  const t = useTranslations("download");
  const locale = useLocale();
  const base = `/${locale}/${date}/${slot}`;
  return (
    <span role="group" aria-label={t("label")} className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <a href={`${base}/print`} className={`chip ui font-semibold ${TARGET}`}>
        <PrinterIcon /> {t("pdf")}
      </a>
      <a href={`${base}/download`} onClick={withImages} className={`chip ui font-semibold ${TARGET}`}>
        <DownloadIcon /> {t("file")}
      </a>
    </span>
  );
}

/** The whole Saved shelf as one HTML file. */
export function ShelfDownloadLink({ className = "" }: { className?: string }) {
  const t = useTranslations("saved");
  const locale = useLocale();
  return (
    <a href={`/${locale}/saved/download`} onClick={withImages} className={`chip ui font-semibold ${TARGET} ${className}`}>
      <DownloadIcon /> {t("downloadAll")}
    </a>
  );
}

function PrinterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0">
      <path d="M7 9V3.5h10V9M7 17H4.5V10a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v7H17M7 14h10v6.5H7z" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M12 3.5v11m-4.5-4.5L12 14.5 16.5 10M4.5 16v4h15v-4" />
    </svg>
  );
}
