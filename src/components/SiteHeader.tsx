"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, X, PhoneCall } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const links = [
  { href: "/trainer", label: "Trainer" },
  { href: "/trainer/scenarios", label: "Scenarios" },
  { href: "/dashboard", label: "Dashboard" },
];

export default function SiteHeader() {
  const { isAuthenticated, user, logout, capabilities } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const demo = capabilities?.demoMode;

  const NavLinks = () => (
    <>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          onClick={() => setOpen(false)}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${pathname === l.href ? "bg-primary-soft text-primary" : "text-ink-soft hover:bg-slate-100"}`}
        >
          {l.label}
        </Link>
      ))}
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur">
      {demo && (
        <div className="bg-accent-soft px-4 py-1 text-center text-xs font-medium text-ink">
          Demo mode: login is skipped and sessions stay in this browser.
        </div>
      )}
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-heading text-base font-bold text-ink">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-white">
            <PhoneCall size={16} aria-hidden />
          </span>
          <span className="hidden min-[400px]:inline">Real-Time Call Trainer</span>
          <span className="min-[400px]:hidden">Call Trainer</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {isAuthenticated && <NavLinks />}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <>
              <span className="max-w-[160px] truncate text-sm text-ink-muted">{user?.firstName || user?.email}</span>
              {!demo && (
                <button className="btn-ghost !min-h-[36px]" onClick={() => { logout(); router.push("/"); }}>
                  Sign out
                </button>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn-ghost !min-h-[36px]">Sign in</Link>
              <Link href="/register" className="btn-primary !min-h-[36px]">Get started</Link>
            </>
          )}
        </div>

        <button className="rounded-lg p-2 md:hidden" aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-line bg-white px-4 pb-4 pt-2 md:hidden">
          <nav className="flex flex-col gap-1" aria-label="Mobile">
            {isAuthenticated ? (
              <>
                <NavLinks />
                {!demo && (
                  <button className="btn-ghost mt-2" onClick={() => { setOpen(false); logout(); router.push("/"); }}>Sign out</button>
                )}
              </>
            ) : (
              <>
                <Link href="/login" onClick={() => setOpen(false)} className="btn-ghost">Sign in</Link>
                <Link href="/register" onClick={() => setOpen(false)} className="btn-primary">Get started</Link>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
