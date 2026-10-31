"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import GoogleButton, { OrDivider } from "@/components/GoogleButton";
import { googleSignupParams } from "@/lib/googleSignup";

type Mode = "solo" | "create" | "join";
const MODES: { id: Mode; label: string }[] = [
  { id: "solo", label: "Just me" },
  { id: "create", label: "Start a team" },
  { id: "join", label: "Join a team (I have a code)" },
];

export default function RegisterPage() {
  const { register, isAuthenticated, capabilities, needsOnboarding } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("solo");
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", password: "", orgName: "", orgCode: "" });
  /** A manager's invite link: /register?code=123456&manager=<id>. */
  const [invite, setInvite] = useState<{ code: string; manager?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated) router.replace(needsOnboarding ? "/onboarding" : mode === "solo" ? "/dashboard" : "/trainer");
  }, [isAuthenticated, needsOnboarding, mode, router]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const code = sp.get("code") ?? "";
    if (/^[0-9]{3,8}$/.test(code)) {
      const manager = sp.get("manager")?.slice(0, 64) || undefined;
      setInvite({ code, manager });
      setMode("join");
      setF((cur) => ({ ...cur, orgCode: code }));
    }
  }, []);

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
        ...(mode === "create"
          ? { newOrgName: f.orgName }
          : mode === "join"
            ? { joinOrgCode: f.orgCode, ...(invite?.manager && invite.code === f.orgCode ? { managerId: invite.manager } : {}) }
            : {}),
      });
      // The effect above sends new accounts on to onboarding.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  const google = googleSignupParams(mode, f.orgCode, invite);

  return (
    <AuthShell title="Create your account" subtitle="Practise on your own, start a team or join one with a code.">
      {capabilities && !capabilities.database && !capabilities.demoMode && (
        <div className="banner-warn mb-4">Registration needs a database. Set <code>DATABASE_URL</code> or use <code>DEMO_MODE=true</code>.</div>
      )}
      {invite && <p className="mb-4 rounded-lg bg-sunken px-3 py-2 text-sm">You&rsquo;re joining team <span className="mono">{invite.code}</span>{invite.manager ? " on your manager\u2019s team" : ""}.</p>}
      {capabilities?.google && (
        <>
          <GoogleButton
            label="Sign up with Google"
            next={mode === "solo" ? "/dashboard" : "/onboarding"}
            disabled={!google}
            {...(google ?? {})}
          />
          {!google && <p className="mt-2 text-xs text-ink-muted">Enter your team code to sign up with Google.</p>}
          <OrDivider />
        </>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor="fn" className="label">First name</label><input id="fn" className="input" value={f.firstName} onChange={set("firstName")} required /></div>
          <div><label htmlFor="ln" className="label">Last name</label><input id="ln" className="input" value={f.lastName} onChange={set("lastName")} required /></div>
        </div>
        <div><label htmlFor="em" className="label">Email</label><input id="em" type="email" className="input" autoComplete="email" value={f.email} onChange={set("email")} required /></div>
        <div><label htmlFor="pw" className="label">Password (10+ characters)</label><input id="pw" type="password" minLength={10} className="input" autoComplete="new-password" value={f.password} onChange={set("password")} required /></div>

        <div className="grid gap-2 rounded-xl bg-sunken p-1 text-sm font-semibold sm:grid-cols-3" role="group" aria-label="How will you use it?">
          {MODES.map((m) => (
            <button type="button" key={m.id} onClick={() => setMode(m.id)} aria-pressed={mode === m.id} className={`min-h-[40px] rounded-lg px-2 ${mode === m.id ? "bg-surface text-primary shadow-sm" : "text-ink-muted"}`}>
              {m.label}
            </button>
          ))}
        </div>
        {mode === "solo" && <p className="text-xs text-ink-muted">You get your own workspace on the Free plan. You can join or start a team later.</p>}
        {mode === "create" && (
          <div><label htmlFor="org" className="label">Team name</label><input id="org" className="input" value={f.orgName} onChange={set("orgName")} required minLength={2} /></div>
        )}
        {mode === "join" && (
          <div><label htmlFor="code" className="label">Team code</label><input id="code" className="input" inputMode="numeric" pattern="[0-9]{3,8}" value={f.orgCode} onChange={set("orgCode")} required /></div>
        )}
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">Already registered? <Link href="/login" className="font-semibold text-primary">Sign in</Link></p>
    </AuthShell>
  );
}
