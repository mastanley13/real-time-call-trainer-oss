"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, LibraryBig, PhoneCall, Users } from "lucide-react";
import { navFor } from "@/components/SiteHeader";
import { useAuth } from "@/contexts/AuthContext";

const ICONS = { "/trainer": PhoneCall, "/library": LibraryBig, "/dashboard": BarChart3, "/team": Users } as const;

/** Bottom tab bar on phones. Hidden on desktop and during a live call. */
export default function MobileTabBar() {
  const { isAuthenticated, user } = useAuth();
  const pathname = usePathname();
  if (!isAuthenticated) return null;
  // Managers and owners get a fourth tab for the team view.
  const links = navFor(user);
  return (
    <>
      {/* Reserve bottom space only while the phone tab bar is mounted so guest pages have no empty strip. */}
      <div data-site-chrome aria-hidden className="h-[calc(3.5rem+1px+env(safe-area-inset-bottom))] md:hidden print:hidden" />
      <nav data-site-chrome aria-label="Main" className={`glass fixed inset-x-0 bottom-0 z-40 border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] md:hidden print:hidden ${pathname.startsWith("/trainer/debrief") ? "deck !bg-surface/90" : ""}`}>
        <div className={`mx-auto grid max-w-md ${links.length > 3 ? "grid-cols-4" : "grid-cols-3"}`}>
          {links.map((l) => {
            const on = l.match(pathname);
            const Icon = ICONS[l.href as keyof typeof ICONS];
            return (
              <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${on ? "text-primary shadow-[inset_0_2px_0_rgb(var(--primary))]" : "text-ink-muted hover:text-ink"}`}>
                <Icon size={20} strokeWidth={1.75} aria-hidden />
                {l.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
