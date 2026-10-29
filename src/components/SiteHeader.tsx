"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogOut, Search, Settings } from "lucide-react";
import LogoMark from "@/components/LogoMark";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth, type User } from "@/contexts/AuthContext";
import { canManageTeam } from "@/lib/team";

export const NAV = [
  { href: "/trainer", label: "Practice", match: (p: string) => p === "/trainer" || p.startsWith("/trainer/debrief") },
  { href: "/library", label: "Library", match: (p: string) => p.startsWith("/library") || p.startsWith("/trainer/scenarios") },
  { href: "/dashboard", label: "Progress", match: (p: string) => p.startsWith("/dashboard") },
];
export const TEAM_NAV = { href: "/team", label: "Team", match: (p: string) => p.startsWith("/team") };

/** Main links for this user. Team shows for managers, owners and platform admins; the server enforces access either way. */
export function navFor(user: User | null) {
  return canManageTeam(user?.role, !!user?.isPlatformAdmin) ? [...NAV, TEAM_NAV] : NAV;
}

/** Opens the command palette, which listens for this event. */
export const openPalette = () => window.dispatchEvent(new CustomEvent("rtct:palette"));

export default function SiteHeader() {
  const { isAuthenticated, user, logout, capabilities } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const demo = capabilities?.demoMode;
  const links = navFor(user);
  // Read the platform after mount so the server render and first client render match.
  const [mac, setMac] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setMac(/mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent));
  }, []);

  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header ref={headerRef} data-site-chrome className={`glass sticky top-0 z-40 border-x-0 border-t-0 pt-[env(safe-area-inset-top)] print:hidden ${pathname.startsWith("/trainer/debrief") ? "deck !bg-surface/90" : ""}`}>
      {demo && (
        <div className="border-b border-line bg-primary-soft/60 px-4 py-1 text-center font-mono text-[11px] text-ink-soft">
          Demo mode · login skipped · sessions stay in this browser
        </div>
      )}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-lg font-heading text-[15px] font-bold text-ink">
          <LogoMark size={30} />
          {/* Visually hidden on narrow phones, not display:none, so the home link keeps an accessible name. */}
          <span className="sr-only min-[400px]:not-sr-only">Call Trainer</span>
          <span className="hidden rounded border border-line px-1.5 py-px font-mono text-[10px] font-medium text-ink-muted sm:inline">OSS</span>
        </Link>

        {isAuthenticated && (
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {links.map((l) => {
              const on = l.match(pathname);
              return (
                <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${on ? "bg-sunken text-ink" : "text-ink-muted hover:bg-sunken hover:text-ink"}`}>
                  {l.label}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {capabilities?.model && capabilities.llm && (
            <Link href="/settings/models" className="chip-model hidden transition-colors hover:border-ink-muted/50 hover:text-ink lg:inline-flex"
              title="Model used for the coach, grading and persona wizard. Open model settings.">
              <span className="lamp lamp-ok !h-1.5 !w-1.5" aria-hidden /> {capabilities.model}
              <span className="sr-only">, open model settings</span>
            </Link>
          )}
          {isAuthenticated && (
            <button type="button" onClick={openPalette} aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} aria-label="Open command palette"
              title={`Search and jump to anything (${mac ? "⌘K" : "Ctrl K"})`}
              className="btn-quiet !min-h-[36px] !gap-2 !px-2.5 sm:border sm:border-line">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <span className="kbd hidden sm:inline-flex">{mac ? "⌘K" : "Ctrl K"}</span>
            </button>
          )}
          {isAuthenticated && (
            <Link href="/settings/models" aria-label="Settings" title="Settings: models and security"
              aria-current={pathname.startsWith("/settings") ? "page" : undefined}
              className={`btn-quiet !min-h-[36px] !px-2.5 ${pathname.startsWith("/settings") ? "bg-sunken text-ink" : ""}`}>
              <Settings size={17} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
          <ThemeToggle />
          {isAuthenticated ? (
            <>
              <span className="hidden max-w-[160px] truncate px-1 text-sm text-ink-muted sm:inline">{user?.firstName || user?.email}</span>
              {!demo && (
                <button className="btn-quiet !min-h-[36px] !px-2.5" onClick={() => { logout(); router.push("/"); }} aria-label="Sign out" title="Sign out">
                  <LogOut size={17} strokeWidth={1.75} aria-hidden />
                </button>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn-quiet !min-h-[36px]">Sign in</Link>
              <Link href="/register" className="btn-primary !min-h-[36px]">Get started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
