"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { useAuth } from "@/contexts/AuthContext";
import { safeNextPath } from "@/lib/safeNext";

/** Where Google sign-in lands: stores the session the server set, then moves on. */
export default function AuthCompletePage() {
  const { adoptSession } = useAuth();
  const router = useRouter();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    adoptSession()
      .then(() => router.replace(next))
      .catch((e: Error) => setError(e.message));
  }, [adoptSession, router]);

  return (
    <AuthShell compact title={error ? "Sign-in didn't finish" : "Signing you in"} subtitle={error ? "Your account is fine. Try signing in again." : "One moment."}>
      {error ? (
        <>
          <p role="alert" className="banner-alert">{error}</p>
          <Link href="/login" className="btn-primary mt-4 w-full">Back to sign in</Link>
        </>
      ) : (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-4 py-3 text-sm text-ink-soft">
          <span className="lamp lamp-signal motion-safe:animate-lamp-pulse" aria-hidden />
          Opening your workspace…
        </div>
      )}
    </AuthShell>
  );
}
