"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import LegalLinks from "@/components/LegalLinks";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from "@/lib/passwordRules";
import { RESET_INVALID_MESSAGE } from "@/lib/passwordReset-types";

export default function ResetPasswordForm() {
  const { capabilities } = useAuth();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`${PASSWORD_MIN_MESSAGE}.`);
      return;
    }
    if (password !== confirm) {
      setError("The passwords do not match. Type the same password in both fields.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        router.replace("/login?reset=1");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (data?.error === "invalid_token") setLinkInvalid(true);
      setError(data?.message ?? "We could not reset your password. Please try again.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!token || linkInvalid) {
    return (
      <AuthShell title="Reset link not valid" subtitle={RESET_INVALID_MESSAGE}>
        <Link href="/forgot-password" className="btn-primary w-full">Request a new link</Link>
        <p className="mt-5 text-center text-sm text-ink-muted">
          <Link href="/login" className="font-semibold text-primary">Back to sign in</Link>
        </p>
        <LegalLinks />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="After you save it, sign in with your new password.">
      {capabilities && !capabilities.database && (
        <div className="banner-warn mb-4">
          Password reset needs a database. Set <code>DATABASE_URL</code> on the server.
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="pw" className="label">New password ({PASSWORD_MIN_LENGTH}+ characters)</label>
          <input id="pw" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="pw2" className="label">Confirm new password</label>
          <input id="pw2" type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-semibold text-primary">Back to sign in</Link>
      </p>
      <LegalLinks />
    </AuthShell>
  );
}
