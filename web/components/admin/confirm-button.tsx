"use client";
import { useState } from "react";

/**
 * Two-step destructive button: the first click arms it, the second submits the surrounding form.
 *
 * It is a submit button from the start and the first click cancels its own default action. (Switching
 * `type` from "button" to "submit" inside the click handler does not work: React re-renders before the
 * browser runs the button's default action, so the very first click submitted the form.)
 */
export function ConfirmButton({ children, confirmLabel = "Confirm delete", className = "" }: { children: React.ReactNode; confirmLabel?: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <button type="submit" onClick={(e) => { if (!armed) { e.preventDefault(); setArmed(true); } }} onBlur={() => setArmed(false)}
      aria-live="polite" className={`chip cursor-pointer ${armed ? "!border-accent !bg-accent !text-accent-ink" : "text-accent"} ${className}`}>
      {armed ? confirmLabel : children}
    </button>
  );
}
