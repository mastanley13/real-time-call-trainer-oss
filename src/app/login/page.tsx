"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import { ACCOUNTS_UNAVAILABLE_COPY, accountsUnavailable } from "@/lib/authUi";

export default function LoginPage() {
  const { login, completeMfaChallenge, isAuthenticated, capabilities } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const unavailable = accountsUnavailable(capabilities);

  useEffect(() => {
    if (isAuthenticated) router.replace("/trainer");
  }, [isAuthenticated, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (unavailable) return;
    setError("");
    setBusy(true);
    try {
      if (challenge) {
        await completeMfaChallenge(challenge, code);
      } else {
        const mfa = await login({ email, password });
        if (mfa) { setChallenge(mfa.challengeToken); setBusy(false); return; }
      }
      router.push("/trainer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to continue practising.">
      {unavailable && (
        <div className="banner-warn mb-4" role="status">
          {ACCOUNTS_UNAVAILABLE_COPY.login} <Link href="/" className="font-semibold underline">Open the demo</Link>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <fieldset disabled={unavailable} className="m-0 min-w-0 space-y-4 border-0 p-0">
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
        <button className="btn-primary w-full" disabled={busy || unavailable}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
        </fieldset>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        New here? <Link href="/register" className="font-semibold text-primary">Create an account</Link>
      </p>
    </AuthShell>
  );
}
