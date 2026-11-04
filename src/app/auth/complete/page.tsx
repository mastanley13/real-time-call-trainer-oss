"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import AuthShell from "@/components/AuthShell";
import { useAuth } from "@/contexts/AuthContext";

/** Where Google sign-in lands: stores the session the server set, then moves on. */
export default function AuthCompletePage() {
  const { adoptSession } = useAuth();
  const router = useRouter();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const raw = new URLSearchParams(window.location.search).get("next") ?? "/trainer";
    const next = raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/trainer";
    adoptSession()
      .then(() => router.replace(next))
      .catch((e: Error) => setError(e.message));
  }, [adoptSession, router]);

  return (
    <AuthShell title={error ? "Sign-in didn't finish" : "Signing you in"} subtitle={error ? "Your account is fine. Try signing in again." : "One moment."}>
      {error ? (
        <>
          <p role="alert" className="text-sm text-alert">{error}</p>
          <Link href="/login" className="btn-primary mt-4 w-full">Back to sign in</Link>
        </>
      ) : (
        <Loader2 size={20} strokeWidth={1.75} className="animate-spin text-ink-muted" aria-label="Loading" />
      )}
    </AuthShell>
  );
}
