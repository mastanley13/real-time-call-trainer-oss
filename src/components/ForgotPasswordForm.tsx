"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Loader2, MailCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import LegalLinks from "@/components/LegalLinks";
import { RESET_REQUEST_MESSAGE } from "@/lib/passwordReset-types";

export default function ForgotPasswordForm() {
  const { capabilities } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second Enter lands here and stops.
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(data?.message ?? "We could not send the link. Please try again.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle="Enter your account email and we will send you a link to choose a new password.">
      {capabilities && !capabilities.database && (
        <div className="banner-warn mb-4">
          Password reset needs a database. Set <code>DATABASE_URL</code> on the server.
        </div>
      )}
      {sent ? (
        <div className="space-y-4">
          <div role="status" className="banner-ok flex items-start gap-2">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" strokeWidth={1.75} aria-hidden />
            <span>{RESET_REQUEST_MESSAGE}</span>
          </div>
          <Link href="/login" className="btn-primary w-full">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" type="email" className="input" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          {error && <p role="alert" className="banner-alert">{error}</p>}
          <button className="btn-primary w-full" aria-disabled={busy || undefined}>
            {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
            {busy ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      {!sent && (
        <p className="mt-5 text-center text-sm text-ink-muted">
          Remembered it? <Link href="/login" className="font-semibold text-primary">Back to sign in</Link>
        </p>
      )}
      <LegalLinks />
    </AuthShell>
  );
}
