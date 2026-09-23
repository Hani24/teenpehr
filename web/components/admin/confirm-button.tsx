"use client";
import { useState } from "react";

/** Two-step destructive button: first click arms it, second click submits the surrounding form. */
export function ConfirmButton({ children, confirmLabel = "Confirm delete", className = "" }: { children: React.ReactNode; confirmLabel?: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <button type={armed ? "submit" : "button"} onClick={() => { if (!armed) setArmed(true); }} onBlur={() => setArmed(false)}
      aria-live="polite" className={`chip cursor-pointer ${armed ? "!border-accent !bg-accent !text-accent-ink" : "text-accent"} ${className}`}>
      {armed ? confirmLabel : children}
    </button>
  );
}
