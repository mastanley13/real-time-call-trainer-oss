"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell, { PasswordInput } from "@/components/AuthShell";
import LegalLinks from "@/components/LegalLinks";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from "@/lib/passwordRules";
import { RESET_INVALID_MESSAGE } from "@/lib/passwordReset-types";
import { applyCheckResult, type CheckOutcome, fetchResetCheck, resetView } from "@/lib/resetLinkCheck";

/** One instance per token: a token change mounts a fresh form, so no state or late reply crosses links. */
export default function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  return <ResetPasswordInstance key={token} token={token} />;
}

function ResetPasswordInstance({ token }: { token: string }) {
  const { capabilities } = useAuth();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  // A local check that failed, tied to the field it is about: the new password (too short) or the confirmation (no match).
  const [fieldError, setFieldError] = useState<{ field: "pw" | "pw2"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const view = resetView(token, outcome);
  // Aborted on unmount; every check and confirm reply is ignored once it is.
  const life = useRef<AbortController | null>(null);
  const gone = () => !life.current || life.current.signal.aborted;

  // Check the link on load so a dead link shows the invalid state before anyone types. An unknown outcome
  // (offline, 5xx, 429) shows the form: the submit verifies the link again.
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    if (token) {
      void fetchResetCheck(token, fetch, controller.signal).then((result) => {
        if (!controller.signal.aborted) setOutcome((prev) => applyCheckResult(prev, result));
      });
    }
    return () => controller.abort();
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second Enter lands here and stops.
    if (busy) return;
    setError("");
    setFieldError(null);
    if (password.length < PASSWORD_MIN_LENGTH) {
      setFieldError({ field: "pw", message: `${PASSWORD_MIN_MESSAGE}.` });
      return;
    }
    if (password !== confirm) {
      setFieldError({ field: "pw2", message: "The passwords do not match. Type the same password in both fields." });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (gone()) return;
      if (res.ok) {
        router.replace("/login?reset=1");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (gone()) return;
      if (data?.error === "invalid_token") setOutcome("invalid");
      setError(data?.message ?? "We could not reset your password. Please try again.");
    } catch {
      if (!gone()) setError("We could not reach the server. Check your connection and try again.");
    } finally {
      if (!gone()) setBusy(false);
    }
  }

  if (view === "no-token" || view === "invalid") {
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

  if (view === "checking") {
    return (
      <AuthShell title="Checking your link" subtitle="This takes a moment.">
        <div role="status" className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-4 py-3 text-sm text-ink-soft">
          <span className="lamp lamp-signal motion-safe:animate-lamp-pulse" aria-hidden />
          Checking your reset link…
        </div>
        <LegalLinks />
      </AuthShell>
    );
  }

  const pwError = fieldError?.field === "pw" ? fieldError.message : "";
  const pw2Error = fieldError?.field === "pw2" ? fieldError.message : "";

  return (
    <AuthShell title="Choose a new password" subtitle="After you save it, sign in with your new password.">
      {capabilities && !capabilities.database && (
        <div className="banner-warn mb-4">
          Password reset needs a database. Set <code>DATABASE_URL</code> on the server.
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="pw" className="label">New password</label>
          <PasswordInput
            id="pw"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={pwError ? true : undefined}
            aria-describedby={pwError ? "pw-hint pw-error" : "pw-hint"}
            required
            autoFocus
          />
          <p id="pw-hint" className="mt-1 text-xs text-ink-muted">Use {PASSWORD_MIN_LENGTH} or more characters.</p>
          {pwError && <p id="pw-error" role="alert" className="field-msg">{pwError}</p>}
        </div>
        <div>
          <label htmlFor="pw2" className="label">Confirm new password</label>
          <PasswordInput
            id="pw2"
            toggleLabel="Show confirmation"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={pw2Error ? true : undefined}
            aria-describedby={pw2Error ? "pw2-error" : undefined}
            required
          />
          {pw2Error && <p id="pw2-error" role="alert" className="field-msg">{pw2Error}</p>}
        </div>
        {error && <p role="alert" className="banner-alert">{error}</p>}
        <button className="btn-primary w-full" aria-disabled={busy || undefined}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-semibold text-primary">Back to sign in</Link>
      </p>
      <LegalLinks />
    </AuthShell>
  );
}
