"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import { ACCOUNTS_COPY, SESSION_COPY, accountFormVisible, accountsState, guardedSubmit } from "@/lib/authUi";

export default function LoginPage() {
  const { login, completeMfaChallenge, isAuthenticated, isLoading, capabilities, configError, retryConfig } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = accountsState(capabilities, configError);
  const blocked = accounts !== "ready";
  const formVisible = accountFormVisible({ isLoading, isAuthenticated, busy });

  useEffect(() => {
    if (isAuthenticated) router.replace("/trainer");
  }, [isAuthenticated, router]);

  function onSubmit(e: FormEvent) {
    guardedSubmit(e, capabilities, submit, configError);
  }

  async function submit() {
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
      {!formVisible && <p className="text-sm text-ink-muted" role="status">{isAuthenticated ? SESSION_COPY.redirecting : SESSION_COPY.checking}</p>}
      {formVisible && accounts === "unavailable" && <div className="banner-warn mb-4" role="status">{ACCOUNTS_COPY.unavailable.login}</div>}
      {formVisible && accounts === "error" && (
        <div className="banner-warn mb-4" role="status">
          {ACCOUNTS_COPY.error} <button type="button" className="font-semibold underline" onClick={retryConfig}>{ACCOUNTS_COPY.retry}</button>
        </div>
      )}
      {formVisible && accounts === "loading" && <p className="mb-4 text-sm text-ink-muted" role="status">{ACCOUNTS_COPY.loading}</p>}
      <form onSubmit={onSubmit} className="space-y-4" hidden={!formVisible}>
        <fieldset disabled={blocked} className="m-0 min-w-0 space-y-4 border-0 p-0">
        {challenge ? (
          <div>
            <label htmlFor="code" className="label">Authenticator code</label>
            <input disabled={blocked} id="code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input disabled={blocked} id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="password" className="label">Password</label>
              <input disabled={blocked} id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || blocked}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
        </fieldset>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">
        New here? <Link href="/register" className="font-semibold text-primary">Create an account</Link>
      </p>
    </AuthShell>
  );
}
