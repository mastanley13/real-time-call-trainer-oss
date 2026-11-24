"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell, { PasswordInput } from "@/components/AuthShell";
import GoogleButton from "@/components/GoogleButton";
import { afterSigninTo, intentFromQuery, rememberNotice } from "@/lib/checkoutStart";
import { signInHref, validNextPath } from "@/lib/safeNext";
import { registerOrgFields } from "@/lib/registerForm";
import { planSummary } from "@/lib/pricing";
import LegalLinks from "@/components/LegalLinks";

const MODES = ["create", "join"] as const;
const MODE_LABELS = { create: "New team", join: "Join a team" } as const;

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const { register, isAuthenticated, capabilities, capabilitiesFailed } = useAuth();
  // The billing state is known once /api/config answers. If it answers with an error (no access cookie behind the
  // access gate), billing reads as off and sign-up stays possible; the register API still enforces the gate.
  const configKnown = capabilities !== null || capabilitiesFailed;
  const router = useRouter();
  // The link's plan, period, src and seg, whitelisted. Anything else in the query is dropped.
  const intent = intentFromQuery(useSearchParams());
  // An invite link (/register?code=123456) opens on "Join a team" with the code filled in. Digits only.
  const codeParam = useSearchParams().get("code") ?? "";
  const inviteCode = /^[0-9]{3,8}$/.test(codeParam) ? codeParam : "";
  // A same-site ?next= path (for example from /try/[role]); anything unsafe is dropped here and again in afterSigninTo.
  const rawNext = useSearchParams().get("next");
  const nextPath = validNextPath(rawNext);
  const summary = planSummary(intent);
  const billingEnabled = capabilities?.billing === true;

  /** Billing on with a plan goes to checkout; else a safe ?next=; else /trainer, with a one-time notice when a plan was asked for. */
  function goAfterSignin() {
    const next = afterSigninTo(billingEnabled, intent, rawNext);
    if (next.notice) rememberNotice(next.notice);
    router.replace(next.path);
  }
  const [mode, setMode] = useState<"create" | "join">(inviteCode ? "join" : "create");
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", password: "", orgName: "", orgCode: inviteCode });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in: record nothing new, follow the billing state. Wait for the capabilities so the state is known.
  useEffect(() => {
    if (isAuthenticated && configKnown) goAfterSignin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, configKnown]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  /** Arrow keys move between the two modes, as in any radio group. */
  function onModeKeys(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const other = mode === "create" ? "join" : "create";
    setMode(other);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[MODES.indexOf(other)]?.focus();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second Enter lands here and stops.
    if (busy) return;
    // The billing state decides where a new account goes, so wait until /api/config has answered.
    if (!configKnown) return;
    setError("");
    setBusy(true);
    try {
      await register({
        firstName: f.firstName,
        lastName: f.lastName,
        email: f.email,
        password: f.password,
        // Only the active mode's field. A blank team name is left out; the server then names the workspace after the rep.
        ...registerOrgFields(mode, f.orgName, f.orgCode),
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
    <AuthShell title="Create your account" subtitle="Practice on your own, start a team, or join one with a code.">
      {capabilities && !capabilities.database && !capabilities.demoMode && (
        <div className="banner-warn mb-4">Registration needs a database. Set <code>DATABASE_URL</code> or use <code>DEMO_MODE=true</code>.</div>
      )}
      {summary && (
        <div role="group" aria-labelledby="plan-h" className="panel mb-4 flex items-center gap-3 px-4 py-3">
          <span className="lamp lamp-signal" aria-hidden />
          <div className="min-w-0 flex-1">
            <p id="plan-h" className="text-xs text-ink-muted">Your plan</p>
            <p className="font-heading text-base font-semibold leading-snug">{summary.name}, {summary.periodLabel}</p>
            {summary.seats && <p className="mt-0.5 text-xs text-ink-muted">{summary.seats}</p>}
          </div>
          <p className="mono shrink-0 text-sm font-semibold text-ink">{summary.price}</p>
        </div>
      )}

      {/* The switch sits above the Google button, so changing it never moves the switch itself. */}
      <div role="radiogroup" aria-label="Workspace" onKeyDown={onModeKeys} className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
        {MODES.map((m) => (
          <button
            type="button"
            key={m}
            role="radio"
            aria-checked={mode === m}
            tabIndex={mode === m ? 0 : -1}
            onClick={() => setMode(m)}
            className={`min-h-[36px] rounded-md px-2 text-sm font-semibold transition ${mode === m ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Google sign-up always starts a new workspace, so joining a team goes through the email form. */}
      {mode === "join" ? (
        <p className="banner-info mb-4 text-ink-soft">Joining a team: sign up with your email below. Google sign-up starts your own workspace.</p>
      ) : (
        <GoogleButton carryIntent next={nextPath ?? undefined} />
      )}
      <form onSubmit={onSubmit} className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div><label htmlFor="fn" className="label">First name</label><input id="fn" className="input" autoComplete="given-name" value={f.firstName} onChange={set("firstName")} required /></div>
          <div><label htmlFor="ln" className="label">Last name</label><input id="ln" className="input" autoComplete="family-name" value={f.lastName} onChange={set("lastName")} required /></div>
        </div>
        <div><label htmlFor="em" className="label">Email</label><input id="em" type="email" className="input" autoComplete="email" value={f.email} onChange={set("email")} required /></div>
        <div>
          <label htmlFor="pw" className="label">Password</label>
          <PasswordInput id="pw" minLength={10} autoComplete="new-password" aria-describedby="pw-hint" value={f.password} onChange={set("password")} required />
          <p id="pw-hint" className="mt-1 text-xs text-ink-muted">Use 10 or more characters.</p>
        </div>
        {mode === "create" ? (
          <div><label htmlFor="org" className="label">Team name (optional)</label><input id="org" className="input" autoComplete="organization" value={f.orgName} onChange={set("orgName")} minLength={2} /></div>
        ) : (
          <div>
            <label htmlFor="code" className="label">Team code</label>
            <input id="code" className="input font-mono tracking-[0.2em]" inputMode="numeric" pattern="[0-9]{3,8}" autoComplete="off" aria-describedby="code-hint" value={f.orgCode} onChange={set("orgCode")} required />
            <p id="code-hint" className="mt-1 text-xs text-ink-muted">The 3 to 8 digit code from your team&apos;s invite.</p>
          </div>
        )}
        {error && <p role="alert" className="banner-alert">{error}</p>}
        <button className="btn-primary w-full" disabled={!configKnown} aria-disabled={busy || undefined}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm text-ink-muted">Already registered? <Link href={signInHref(nextPath)} className="font-semibold text-primary">Sign in</Link></p>
      <LegalLinks />
    </AuthShell>
  );
}
