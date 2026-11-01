"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { isEnrollmentPath } from "@/lib/mfaPolicy";

type Grace = { endsAt: string } | null;

/**
 * Org MFA rule, client side. Asks the server on each page whether the org
 * requires MFA. Members who must enrol are sent to /settings/security and kept
 * there; members in a grace period see a banner. The server enforces the rule
 * on every API call, so this only keeps people from landing on pages that
 * would show errors.
 */
export default function MfaGate() {
  const { user, isAuthenticated, capabilities, setMfaEnrollment } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [grace, setGrace] = useState<Grace>(null);
  const stored = !!capabilities && !capabilities.demoMode && capabilities.database;
  const userId = user?.id;

  useEffect(() => {
    if (!isAuthenticated || !stored || !userId) { setGrace(null); return; }
    let live = true;
    fetch("/api/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!live || !me?.mfa) return;
        setMfaEnrollment(me.mfa.state === "enroll_required");
        setGrace(me.mfa.state === "grace" && me.mfa.graceEndsAt ? { endsAt: me.mfa.graceEndsAt } : null);
      })
      .catch(() => {});
    return () => { live = false; };
    // Re-check on each page so a reset or a newly enforced rule shows up without a fresh sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, stored, userId, pathname]);

  const mustEnrol = !!user?.mfaEnrollment;
  useEffect(() => {
    if (mustEnrol && !isEnrollmentPath(pathname)) router.replace("/settings/security");
  }, [mustEnrol, pathname, router]);

  if (!grace || mustEnrol || pathname === "/settings/security") return null;
  const days = Math.max(1, Math.ceil((new Date(grace.endsAt).getTime() - Date.now()) / 86_400_000));
  return (
    <div role="status" className="banner-warn mx-auto mt-3 max-w-7xl">
      Your organization requires multi-factor authentication. Set it up within {days} {days === 1 ? "day" : "days"} to keep practising.{" "}
      <Link href="/settings/security" className="font-semibold underline">Set up MFA</Link>
    </div>
  );
}
