"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import LegalLinks from "@/components/LegalLinks";

export default function LoginPage() {
  const { login, completeMfaChallenge, isAuthenticated, capabilities } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated) router.replace("/trainer");
  }, [isAuthenticated, router]);

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
      router.push("/trainer");
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
        New here? <Link href="/register" className="font-semibold text-primary">Create an account</Link>
      </p>
      <LegalLinks />
    </AuthShell>
  );
}
