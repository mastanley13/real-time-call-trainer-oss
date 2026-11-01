"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { MOBILE_MENU_ID, MOBILE_MENU_QUERY, closeMenu, dismissOutside, focusFirstLink, handleMenuKey, leaveMobileRange, menuButtonLabel } from "@/lib/mobileMenu";

export interface MobileMenuItem {
  href: string;
  label: string;
  active?: boolean;
}

/** Menu button and panel for phones, where the inline header links do not fit. Hidden above 427px. */
export default function MobileMenu({ items, guest, pathname }: { items: MobileMenuItem[]; guest: boolean; pathname: string }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => closeMenu(setOpen, buttonRef.current);

  useEffect(() => {
    if (open) focusFirstLink(panelRef.current?.querySelectorAll<HTMLElement>("a") ?? []);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (handleMenuKey(e.key, open, close)) e.preventDefault();
    };
    // Click, not pointerdown: focus has already moved by then, so restoring it to the button sticks.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) dismissOutside(t, setOpen, buttonRef.current);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  // Leaving the phone range hides the button and panel, so reset instead of leaving a hidden open menu behind.
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MENU_QUERY);
    const onChange = () => {
      if (mql.matches) return;
      const inside = !!panelRef.current?.contains(document.activeElement);
      leaveMobileRange(setOpen, inside, buttonRef.current?.closest("header")?.querySelector<HTMLElement>("a") ?? null);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // A route change closes the menu without stealing focus from the new page.
  useEffect(() => setOpen(false), [pathname]);

  const Icon = open ? X : Menu;
  return (
    <div className="hidden max-[427px]:block">
      <button ref={buttonRef} type="button" onClick={() => (open ? close() : setOpen(true))}
        aria-label={menuButtonLabel(open)} aria-expanded={open} aria-controls={MOBILE_MENU_ID}
        className="btn-quiet !min-h-[44px] !min-w-[44px] !px-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <Icon size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <div id={MOBILE_MENU_ID} ref={panelRef} hidden={!open}
        className="absolute inset-x-0 top-full border-b border-line bg-surface px-4 py-3 shadow-pop">
        <nav aria-label="Menu" className="flex flex-col gap-1">
          {items.map((l) => (
            <Link key={l.href} href={l.href} onClick={close} aria-current={l.active ? "page" : undefined}
              className={`flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium ${l.active ? "bg-sunken text-ink" : "text-ink-soft hover:bg-sunken hover:text-ink"}`}>
              {l.label}
            </Link>
          ))}
          {guest && (
            <>
              <Link href="/login" onClick={close} className="btn-quiet !justify-start !px-3 !min-h-[44px]">Sign in</Link>
              <Link href="/register" onClick={close} className="btn-primary !min-h-[44px]">Get started</Link>
            </>
          )}
        </nav>
      </div>
    </div>
  );
}
