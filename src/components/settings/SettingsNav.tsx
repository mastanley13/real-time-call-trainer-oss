"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, Cpu, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const LINKS = [
  { href: "/settings/security", label: "Security", icon: ShieldCheck },
  { href: "/settings/models", label: "Models", icon: Cpu },
];
const BILLING = { href: "/settings/billing", label: "Billing", icon: CreditCard };

/** Tabs shared by the settings pages. Billing appears only when Stripe test mode is configured. */
export default function SettingsNav({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const { capabilities } = useAuth();
  const links = capabilities?.billing ? [...LINKS, BILLING] : LINKS;
  return (
    <nav aria-label="Settings" className={`inline-flex gap-1 rounded-lg border border-line bg-surface p-1 shadow-card ${className}`}>
      {links.map(({ href, label, icon: Icon }) => {
        const on = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={on ? "page" : undefined}
            className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${on ? "bg-primary-soft text-primary" : "text-ink-soft hover:bg-sunken hover:text-ink"}`}>
            <Icon size={14} strokeWidth={1.75} aria-hidden /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
