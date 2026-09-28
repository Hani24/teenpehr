"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * A <details> disclosure that behaves like a menu once scripts run: it closes on navigation, on a
 * click outside it, and on Escape (focus goes back to its summary). Without scripts it is a plain
 * <details>, which still opens and closes.
 */
export function MenuDetails({ className, children }: { className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const d = ref.current;
      if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      const d = ref.current;
      if (e.key !== "Escape" || !d?.open) return;
      d.open = false;
      d.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return <details ref={ref} className={className}>{children}</details>;
}
