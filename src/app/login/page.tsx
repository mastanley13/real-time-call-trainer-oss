"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell, { PasswordInput } from "@/components/AuthShell";
import GoogleButton, { GOOGLE_ERRORS } from "@/components/GoogleButton";
import LegalLinks from "@/components/LegalLinks";
import { loginDestination, validNextPath } from "@/lib/safeNext";
import { EXPIRED_REASON } from "@/lib/sessionExpiry";

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { login, completeMfaChallenge, isAuthenticated, capabilities } = useAuth();
  const router = useRouter();
  // The current ?next=, read on every render. The Google return effect below keeps a safe one in the URL.
  const nextParam = useSearchParams().get("next");
  const destination = loginDestination(nextParam);
  // Set by the stale-session redirect in src/lib/sessionExpiry.ts. Only the exact value shows the notice.
  const sessionExpired = useSearchParams().get("reason") === EXPIRED_REASON;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (isAuthenticated) router.replace(destination);
  }, [isAuthenticated, router, destination]);

  // Coming back from Google: an error code in the query, or an MFA challenge in the fragment
  // (fragments never reach a server). Coming back from a password reset: ?reset=1.
  // Read once, then clear them from the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const err = url.searchParams.get("error");
    const mfa = new URLSearchParams(url.hash.slice(1)).get("mfa");
    const reset = url.searchParams.get("reset") === "1";
    if (err) setError(GOOGLE_ERRORS[err] ?? GOOGLE_ERRORS.google_failed);
    if (mfa) setChallenge(mfa);
    if (reset) setResetDone(true);
    // Clear error, the fragment and reset=1, but keep a safe next so the sign-in still lands there.
    const keepNext = validNextPath(url.searchParams.get("next"));
    if (err || mfa || reset) window.history.replaceState(null, "", keepNext ? `${url.pathname}?next=${encodeURIComponent(keepNext)}` : url.pathname);
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second Enter lands here and stops.
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (challenge) {
        await completeMfaChallenge(challenge, code);
      } else {
        const mfa = await login({ email, password });
        if (mfa) { setChallenge(mfa.challengeToken); setBusy(false); return; }
      }
      router.push(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  // On the code step, rejected-code errors sit under the field; network/rate-limit/server errors stay in the form banner.
  const isFormLevel = /^could not reach|^too many|^something went wrong|^network/i.test(error);
  const codeError = challenge && !isFormLevel ? error : "";
  const formError = challenge && !isFormLevel ? "" : error;

  return (
    <AuthShell
      title={challenge ? "Enter your authenticator code" : "Welcome back"}
      subtitle={challenge ? "Two-factor sign-in is on for this account." : "Sign in to continue practicing."}
    >
      {capabilities && !capabilities.database && !capabilities.demoMode && (
        <div className="banner-warn mb-4">
          No database is configured, so accounts are unavailable. Set <code>DATABASE_URL</code>, or run with <code>DEMO_MODE=true</code> to skip login (see TESTING.md).
        </div>
      )}
      {resetDone && !challenge && (
        <div role="status" className="banner-ok mb-4">Your password was reset. Sign in with your new password.</div>
      )}
      {sessionExpired && !resetDone && !challenge && (
        <div role="status" className="banner-warn mb-4">Your session expired. Sign in again.</div>
      )}
      {!challenge && <GoogleButton next={validNextPath(nextParam) ?? undefined} />}
      <form onSubmit={onSubmit} className="space-y-4">
        {challenge ? (
          <div>
            <label htmlFor="code" className="label">Authenticator code</label>
            <input
              id="code"
              className="input font-mono text-center text-lg tracking-[0.35em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? "code-help code-error" : "code-help"}
              required
            />
            <p id="code-help" className="mt-1.5 text-xs text-ink-muted">Open your authenticator app and type the 6-digit code it shows.</p>
            {codeError && <p id="code-error" role="alert" className="field-msg">{codeError}</p>}
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <label htmlFor="password" className="label mb-0">Password</label>
                <Link href="/forgot-password" className="text-xs font-semibold text-primary">Forgot password?</Link>
              </div>
              <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {formError && <p role="alert" className="banner-alert">{formError}</p>}
        <button className="btn-primary w-full" aria-disabled={busy || undefined}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {busy ? (challenge ? "Verifying…" : "Signing in…") : challenge ? "Verify" : "Sign in"}
        </button>
      </form>
      {!challenge && (
        <p className="mt-5 text-center text-sm text-ink-muted">
          New here? <Link href="/register" className="font-semibold text-primary">Create an account</Link>
        </p>
      )}
      <LegalLinks />
    </AuthShell>
  );
}
