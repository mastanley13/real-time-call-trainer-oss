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
    <nav data-site-chrome aria-label="Main" className={`glass fixed inset-x-0 bottom-0 z-40 border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] md:hidden print:hidden ${pathname.startsWith("/trainer/debrief") ? "deck !bg-surface/90" : ""}`}>
      <div className={`mx-auto grid max-w-md ${links.length > 3 ? "grid-cols-4" : "grid-cols-3"}`}>
        {links.map((l) => {
          const on = l.match(pathname);
          const Icon = ICONS[l.href as keyof typeof ICONS];
          return (
            <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined}
              className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? "text-primary" : "text-ink-muted"}`}>
              <Icon size={20} strokeWidth={1.75} aria-hidden />
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
