"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogOut, Search, Settings } from "lucide-react";
import LogoMark from "@/components/LogoMark";
import MobileMenu from "@/components/MobileMenu";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth, type User } from "@/contexts/AuthContext";
import { AI_CHIP_LABEL, showModelChip } from "@/lib/modelChip";
import { canManageTeam } from "@/lib/team";

export const NAV = [
  { href: "/trainer", label: "Practice", match: (p: string) => p === "/trainer" || p.startsWith("/trainer/debrief") },
  { href: "/library", label: "Library", match: (p: string) => p.startsWith("/library") || p.startsWith("/trainer/scenarios") },
  { href: "/dashboard", label: "Progress", match: (p: string) => p.startsWith("/dashboard") },
];
export const PRICING_NAV = { href: "/pricing", label: "Pricing", match: (p: string) => p.startsWith("/pricing") };
export const TEAM_NAV = { href: "/team", label: "Team", match: (p: string) => p.startsWith("/team") };
/** The launch championship. Public, so guests and signed-in users both see it, next to Pricing. */
export const COMPETE_NAV = { href: "/compete", label: "Compete", match: (p: string) => p.startsWith("/compete") };

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
  // Compete and Pricing are public, so every visitor gets them after the signed-in links.
  const barLinks = [...(isAuthenticated ? links : []), COMPETE_NAV, PRICING_NAV];
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
        <div className="flex items-center justify-center gap-2 border-b border-line bg-sunken/90 px-4 py-1.5 text-center font-mono text-[11px] text-ink-soft">
          <span className="lamp lamp-signal !h-1.5 !w-1.5" aria-hidden />
          <span>Demo mode: login skipped, sessions stay in this browser</span>
        </div>
      )}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-5 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-lg font-heading text-[15px] font-bold tracking-tight text-ink">
          <LogoMark size={30} />
          {/* Guests have fewer header buttons so the wordmark fits at 375px; signed-in phones hide it below 440px to prevent horizontal overflow. */}
          <span className={isAuthenticated ? "sr-only min-[440px]:not-sr-only" : "sr-only min-[340px]:not-sr-only"}>Call Trainer</span>
          <span className={`hidden rounded border border-line bg-sunken px-1.5 py-px font-mono text-[10px] font-medium text-ink-muted sm:inline ${isAuthenticated ? "md:max-lg:hidden" : ""}`}>OSS</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {barLinks.map((l) => {
              const on = l.match(pathname);
              return (
                <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined}
                  className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors lg:px-3 ${on ? "bg-sunken text-ink shadow-[inset_0_-2px_0_rgb(var(--primary))]" : "text-ink-muted hover:bg-sunken hover:text-ink"}`}>
                  {l.label}
                </Link>
              );
            })}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          {capabilities && showModelChip(capabilities, user) && (
            <Link href="/settings/models" className="chip-model hidden transition-colors hover:border-ink-muted/50 hover:text-ink lg:inline-flex"
              title="An AI model runs the coach, grading and persona wizard. Open model settings.">
              <span className="lamp lamp-ok !h-1.5 !w-1.5" aria-hidden /> {AI_CHIP_LABEL}
              <span className="sr-only">, open model settings</span>
            </Link>
          )}
          {isAuthenticated && (
            <button type="button" onClick={openPalette} aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} aria-label="Open command palette"
              title={`Search and jump to anything (${mac ? "⌘K" : "Ctrl K"})`}
              className="btn-quiet !min-h-[40px] !min-w-[40px] !gap-2 !px-2 sm:!min-h-[36px] sm:!min-w-0 sm:border sm:border-line sm:!px-2.5">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <span className="kbd hidden sm:inline-flex md:max-lg:hidden">{mac ? "⌘K" : "Ctrl K"}</span>
            </button>
          )}
          {isAuthenticated && (
            <Link href="/settings/models" aria-label="Settings" title="Settings: models and security"
              aria-current={pathname.startsWith("/settings") ? "page" : undefined}
              className={`btn-quiet !min-h-[40px] !min-w-[40px] !px-2 sm:!min-h-[36px] sm:!min-w-[36px] ${pathname.startsWith("/settings") ? "bg-sunken text-ink" : ""}`}>
              <Settings size={17} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
          <ThemeToggle />
          {isAuthenticated ? (
            <>
              <span className="hidden max-w-[160px] truncate px-1 text-sm text-ink-muted md:inline">{user?.firstName || user?.email}</span>
              {!demo && (
                <button className="btn-quiet !min-h-[40px] !min-w-[40px] !px-2 sm:!min-h-[36px] sm:!min-w-[36px]" onClick={() => { logout(); router.push("/"); }} aria-label="Sign out" title="Sign out">
                  <LogOut size={17} strokeWidth={1.75} aria-hidden />
                </button>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn-quiet !min-h-[36px] max-sm:hidden">Sign in</Link>
              <Link href="/register" className="btn-primary !min-h-[36px] max-sm:hidden">Get started</Link>
            </>
          )}
          <MobileMenu pathname={pathname} guest={!isAuthenticated}
            items={barLinks.map((l) => ({ href: l.href, label: l.label, active: l.match(pathname) }))} />
        </div>
      </div>
    </header>
  );
}
