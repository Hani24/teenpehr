"use client";
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import type { ThemeBoot } from "@/lib/view";
import { DisplayFields, QuickDisplay } from "./theme-controls";
import { IconBoard, IconClose, IconDisplay, IconMenu, IconSearch, IconToday } from "./icons";

/*
 * Phones (under Tailwind's `sm`, 40rem): the masthead is a slim sticky bar (the name, the other
 * language and Menu), the main places are a bottom navigation (signed in), and everything else is in
 * one menu sheet: the Wazeh text size at its top, the rest of the pages, the account, and every
 * display choice. Tablets and desktops keep the full masthead and never show these.
 *
 * The sheet is a modal <dialog>: the page behind it is inert (focus stays in the sheet), Escape and the
 * Close button close it, and focus goes back to the button that opened it. The buttons carry invoker
 * commands (commandfor/command), so where the browser supports them the sheet opens and closes before
 * the page's scripts have loaded on a slow connection; elsewhere the click handlers do it once hydrated.
 */
export const SHEET_ID = "site-menu";
const PHONE_MAX = "(width < 40rem)";

let opener: HTMLElement | null = null;
function sheet(): HTMLDialogElement | null {
  const d = document.getElementById(SHEET_ID);
  return d instanceof HTMLDialogElement ? d : null;
}
const openCommand = { commandfor: SHEET_ID, command: "show-modal" };
const closeCommand = { commandfor: SHEET_ID, command: "close" };
/** The browser runs the buttons' commands itself (Chrome 135+, Safari 26.2+, Firefox 144+). */
const nativeCommands = () => "commandForElement" in HTMLButtonElement.prototype;

/** Menu: in the top bar (`bar`) and as the last item of the bottom navigation (`tab`). */
export function MenuButton({ variant, signedIn }: { variant: "bar" | "tab"; signedIn: boolean }) {
  const t = useTranslations();
  // Signed out (the sign-in pages) the sheet holds only the display choices, and says so.
  const label = signedIn ? t("nav.menu") : t("display.open");
  const Icon = signedIn ? IconMenu : IconDisplay;
  return (
    <button type="button" {...openCommand} aria-haspopup="dialog" aria-controls={SHEET_ID}
      data-menu-button={variant === "bar" ? "" : undefined} className={variant === "bar" ? "bar-btn" : "tabbar-item"}
      onClick={(e) => {
        opener = e.currentTarget;
        const d = sheet();
        if (d && !d.open && !nativeCommands()) d.showModal();
      }}>
      <Icon />
      <span className={variant === "tab" ? "tabbar-label" : undefined}>{label}</span>
    </button>
  );
}

export function MenuSheet({ boot, signedIn, children }: { boot: ThemeBoot; signedIn: boolean; children?: React.ReactNode }) {
  const t = useTranslations();
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  // Another page (a link in the sheet, or back and forward): it closes. Only on a change, so a sheet
  // opened before the scripts loaded stays open when they do.
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    ref.current?.close();
  }, [pathname]);
  // Turned or resized past the phone layout: the tablet and desktop masthead has everything.
  useEffect(() => {
    const phone = matchMedia(PHONE_MAX);
    const onChange = () => { if (!phone.matches) ref.current?.close(); };
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog ref={ref} id={SHEET_ID} aria-labelledby={`${SHEET_ID}-title`} className="sheet ui no-print"
      onClick={(e) => { if ((e.target as Element).closest("a[href]")) close(); }}
      onClose={() => {
        // The browser gives focus back to what had it. After a tap nothing had it, and focus would stay
        // on the sheet's now hidden Close button (then fall to the page): the button that opened the sheet
        // takes it instead, if it is still shown.
        const a = document.activeElement;
        if ((!a || a === document.body || ref.current?.contains(a)) && opener?.isConnected && opener.getClientRects().length) opener.focus();
      }}>
      <div className="sheet-head">
        <h2 id={`${SHEET_ID}-title`} className="sheet-title">{signedIn ? t("nav.menu") : t("display.title")}</h2>
        <button type="button" {...closeCommand} onClick={() => { if (!nativeCommands()) close(); }} className="bar-btn sheet-close">
          <IconClose />
          <span>{t("nav.close")}</span>
        </button>
      </div>
      <div className="sheet-body">
        <QuickDisplay boot={boot} />
        {children}
        {signedIn ? (
          <section aria-labelledby={`${SHEET_ID}-display`} className="sheet-section">
            <h3 id={`${SHEET_ID}-display`} className="sheet-heading">{t("display.title")}</h3>
            <div className="grid gap-6"><DisplayFields boot={boot} omitQuick /></div>
          </section>
        ) : (
          // Signed out the whole sheet is the display choices, under its own title.
          <div className="grid gap-6"><DisplayFields boot={boot} omitQuick /></div>
        )}
      </div>
    </dialog>
  );
}

/**
 * The bottom navigation on phones, signed in: Today, Search, the X board and Menu, each an icon and its
 * words. Fixed to the bottom of the screen above the device's home indicator; the spacer before it keeps
 * the end of the page (the footer) clear of it.
 */
export function BottomNav() {
  const t = useTranslations();
  const pathname = usePathname();
  const items = [
    { href: "/", label: t("nav.today"), Icon: IconToday, current: pathname === "/", prefetch: undefined },
    { href: "/search", label: t("search.entry"), Icon: IconSearch, current: pathname.startsWith("/search"), prefetch: false },
    { href: "/x", label: t("board.nav"), Icon: IconBoard, current: pathname === "/x" || pathname.startsWith("/x/"), prefetch: undefined },
  ];
  return (
    <>
      <div className="tabbar-spacer no-print" aria-hidden="true" />
      <nav aria-label={t("nav.primary")} className="tabbar no-print" data-bottomnav="">
        {items.map(({ href, label, Icon, current, prefetch }) => (
          <Link key={href} href={href} prefetch={prefetch} aria-current={current ? "page" : undefined} className="tabbar-item">
            <Icon />
            <span className="tabbar-label">{label}</span>
          </Link>
        ))}
        <MenuButton variant="tab" signedIn />
      </nav>
    </>
  );
}
