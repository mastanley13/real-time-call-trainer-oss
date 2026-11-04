"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import GoogleButton, { GOOGLE_ERRORS } from "@/components/GoogleButton";
import LegalLinks from "@/components/LegalLinks";
import { inviteTokenFromPath } from "@/lib/invites";
import { safeNextPath } from "@/lib/safeNext";

/** Where to go after signing in: a same-site ?next= path (an invite link, for example), else /trainer. */
const nextPath = () => safeNextPath(new URLSearchParams(window.location.search).get("next"));

/** From an invite, sign-up carries the invite so the new account can accept it. */
function registerHref(next: string | null): string {
  const token = inviteTokenFromPath(next);
  return token ? `/register?invite=${token}` : "/register";
}

export default function LoginPage() {
  const { login, completeMfaChallenge, isAuthenticated, capabilities } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) router.replace(nextPath());
  }, [isAuthenticated, router]);

  // Coming back from Google: an error code in the query, or an MFA challenge in the fragment
  // (fragments never reach a server). Read once, then clear them from the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const err = url.searchParams.get("error");
    const mfa = new URLSearchParams(url.hash.slice(1)).get("mfa");
    if (err) setError(GOOGLE_ERRORS[err] ?? GOOGLE_ERRORS.google_failed);
    if (mfa) setChallenge(mfa);
    const keep = url.searchParams.get("next");
    // Clear the error and challenge, but keep ?next= so an invite link still lands after sign-in.
    if (err || mfa) window.history.replaceState(null, "", keep ? `${url.pathname}?${new URLSearchParams({ next: keep })}` : url.pathname);
    if (keep) setNext(safeNextPath(keep));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (challenge) {
        await completeMfaChallenge(challenge, code);
      } else {
        const mfa = await login({ email, password });
        if (mfa) { setChallenge(mfa.challengeToken); setBusy(false); return; }
      }
      router.push(nextPath());
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
      {!challenge && <GoogleButton next={next ?? undefined} />}
      <form onSubmit={onSubmit} className="space-y-4">
        {challenge ? (
          <div>
            <label htmlFor="code" className="label">Authenticator code</label>
            <input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="password" className="label">Password</label>
              <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        New here? <Link href={registerHref(next)} className="font-semibold text-primary">Create an account</Link>
      </p>
      <LegalLinks />
    </AuthShell>
  );
}
