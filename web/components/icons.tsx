/**
 * Line icons for the phone bars and the menu sheet (components/site-menu.tsx, masthead.tsx). Always
 * decorative: every control that shows one also shows its words, so they are hidden from assistive
 * technology. They are drawn in the text colour and sized by the CSS of the control that holds them.
 * `flip-rtl` mirrors a directional one on Urdu pages.
 */
type P = { className?: string };
function Svg({ className, children }: P & { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}

export const IconMenu = (p: P) => <Svg {...p}><path d="M4 6.5h16M4 12h16M4 17.5h16" /></Svg>;
export const IconDisplay = (p: P) => <Svg {...p}><path d="M4 7h9M19 7h1M4 17h3M13 17h7" /><circle cx="16" cy="7" r="2.5" /><circle cx="10" cy="17" r="2.5" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconToday = (p: P) => <Svg {...p}><path d="M4 5h13v14H6.5A2.5 2.5 0 0 1 4 16.5V5Z" /><path d="M17 9h3v7.5a2.5 2.5 0 0 1-5 0" /><path d="M7.5 9h6M7.5 12.5h6M7.5 16h3.5" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></Svg>;
export const IconBoard = (p: P) => <Svg {...p}><path d="M4 5h16v11H10l-6 4V5Z" /><path d="M8 9h8M8 12.5h5" /></Svg>;
export const IconSaved = (p: P) => <Svg {...p}><path d="M6.5 4h11v16L12 16l-5.5 4V4Z" /></Svg>;
export const IconArchive = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="4.5" rx="1" /><path d="M5 8.5V20h14V8.5M10 12.5h4" /></Svg>;
export const IconAbout = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></Svg>;
export const IconAccount = (p: P) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4.5 20c1.4-3.8 4.2-5.5 7.5-5.5s6.1 1.7 7.5 5.5" /></Svg>;
export const IconAdmin = (p: P) => <Svg {...p}><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16v4Z" /><path d="m14 6 4 4" /></Svg>;
export const IconSignOut = ({ className = "" }: P) => <Svg className={`flip-rtl ${className}`}><path d="M10 4H5.5v16H10" /><path d="m15 8 4 4-4 4M19 12H9.5" /></Svg>;
