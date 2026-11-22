"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import GoogleButton, { GOOGLE_ERRORS } from "@/components/GoogleButton";
import LegalLinks from "@/components/LegalLinks";
import { loginDestination, validNextPath } from "@/lib/safeNext";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  // MFA step: an authenticator code by default, or a single-use recovery code.
  const [useRecovery, setUseRecovery] = useState(false);
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
    setError("");
    setBusy(true);
    try {
      if (challenge) {
        await completeMfaChallenge(challenge, code, useRecovery ? "recovery" : "totp");
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

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to continue practising.">
      {capabilities && !capabilities.database && !capabilities.demoMode && (
        <div className="banner-warn mb-4">
          No database is configured, so accounts are unavailable. Set <code>DATABASE_URL</code>, or run with <code>DEMO_MODE=true</code> to skip login (see TESTING.md).
        </div>
      )}
      {resetDone && !challenge && (
        <div role="status" className="banner-ok mb-4">Your password was reset. Sign in with your new password.</div>
      )}
      {!challenge && <GoogleButton next={validNextPath(nextParam) ?? undefined} />}
      <form onSubmit={onSubmit} className="space-y-4">
        {challenge ? (
          <div>
            {useRecovery ? (
              <>
                <label htmlFor="recovery-code" className="label">Recovery code</label>
                <input id="recovery-code" className="input font-mono" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={64} placeholder="xxxx-xxxx-xxxx" aria-describedby="recovery-code-hint" value={code} onChange={(e) => setCode(e.target.value)} required />
                <p id="recovery-code-hint" className="mt-1 text-xs text-ink-muted">Each recovery code works once. Case, spaces and dashes don&apos;t matter.</p>
              </>
            ) : (
              <>
                <label htmlFor="code" className="label">Authenticator code</label>
                <input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </>
            )}
            <button
              type="button"
              className="btn-quiet btn-sm mt-2 -ml-3"
              onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(""); }}
            >
              {useRecovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
            </button>
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
              <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        New here? <Link href="/register" className="font-semibold text-primary">Create an account</Link>
      </p>
      <LegalLinks />
    </AuthShell>
  );
}
