"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import { afterSignin, intentFromQuery, rememberNotice } from "@/lib/checkoutStart";

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const { register, isAuthenticated, capabilities } = useAuth();
  const router = useRouter();
  // The link's plan, period, src and seg, whitelisted. Anything else in the query is dropped.
  const intent = intentFromQuery(useSearchParams());
  const billingEnabled = capabilities?.billing === true;

  /** Billing on with a plan goes to checkout; otherwise /trainer, with a one-time notice when a plan was asked for. */
  function goAfterSignin() {
    const next = afterSignin(billingEnabled, intent);
    if (next.notice) rememberNotice(next.notice);
    router.replace(next.path);
  }
  const [mode, setMode] = useState<"create" | "join">("create");
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", password: "", orgName: "", orgCode: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in: record nothing new, follow the billing state. Wait for the capabilities so the state is known.
  useEffect(() => {
    if (isAuthenticated && capabilities) goAfterSignin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, capabilities]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await register({
        firstName: f.firstName,
        lastName: f.lastName,
        email: f.email,
        password: f.password,
        ...(mode === "create" ? { newOrgName: f.orgName } : { joinOrgCode: f.orgCode }),
        ...intent,
      });
      goAfterSignin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Start a team workspace or join one with a code.">
      {capabilities && !capabilities.database && !capabilities.demoMode && (
        <div className="banner-warn mb-4">Registration needs a database. Set <code>DATABASE_URL</code> or use <code>DEMO_MODE=true</code>.</div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor="fn" className="label">First name</label><input id="fn" className="input" value={f.firstName} onChange={set("firstName")} required /></div>
          <div><label htmlFor="ln" className="label">Last name</label><input id="ln" className="input" value={f.lastName} onChange={set("lastName")} required /></div>
        </div>
        <div><label htmlFor="em" className="label">Email</label><input id="em" type="email" className="input" autoComplete="email" value={f.email} onChange={set("email")} required /></div>
        <div><label htmlFor="pw" className="label">Password (10+ characters)</label><input id="pw" type="password" minLength={10} className="input" autoComplete="new-password" value={f.password} onChange={set("password")} required /></div>

        <div className="grid grid-cols-2 gap-2 rounded-xl bg-sunken p-1 text-sm font-semibold">
          {(["create", "join"] as const).map((m) => (
            <button type="button" key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`min-h-[40px] rounded-lg ${mode === m ? "bg-surface text-primary shadow-sm" : "text-ink-muted"}`}>
              {m === "create" ? "New team" : "Join a team"}
            </button>
          ))}
        </div>
        {mode === "create" ? (
          <div><label htmlFor="org" className="label">Team name</label><input id="org" className="input" value={f.orgName} onChange={set("orgName")} required minLength={2} /></div>
        ) : (
          <div><label htmlFor="code" className="label">Team code</label><input id="code" className="input" inputMode="numeric" pattern="[0-9]{3,8}" value={f.orgCode} onChange={set("orgCode")} required /></div>
        )}
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">Already registered? <Link href="/login" className="font-semibold text-primary">Sign in</Link></p>
    </AuthShell>
  );
}
