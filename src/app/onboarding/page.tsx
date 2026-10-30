"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, Sparkles, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { LIBRARY } from "@/lib/personas";
import { JOB_FAMILIES, jobFamilyLabel } from "@/lib/scenarios";
import { syncTeamPersonas } from "@/lib/scenarioStore";
import { canManageTeam } from "@/lib/team";
import { suggestForIndustries } from "@/lib/teamPersonas";

/**
 * First-run setup: create or join a team, pick the industries the team sells
 * in, import matching personas from the library (or build your own), then
 * finish. Reps who joined a team skip straight to the end.
 */

interface State {
  user: { id: string; role: string; firstName: string | null; isPlatformAdmin: boolean };
  organization: { id: string; name: string; code: string; industries: string[] } | null;
  manager: { id: string; name: string } | null;
  needsOnboarding: boolean;
}
type Step = "team" | "industries" | "personas" | "done";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || "Something went wrong. Try again in a minute.");
  return body as T;
}

export default function OnboardingPage() {
  const { isAuthenticated, isLoading, capabilities, finishOnboarding } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [step, setStep] = useState<Step>("team");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [orgName, setOrgName] = useState("");
  const [code, setCode] = useState("");
  const [industries, setIndustries] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const manages = !!state && canManageTeam(state.user.role, state.user.isPlatformAdmin);
  const suggestions = useMemo(() => suggestForIndustries(LIBRARY, [...industries]), [industries]);

  useEffect(() => {
    if (isLoading || !capabilities) return;
    if (capabilities.demoMode || !capabilities.database) { router.replace("/trainer"); return; }
    if (!isAuthenticated) { router.replace("/login"); return; }
    call<State>("/api/onboarding")
      .then((s) => {
        setState(s);
        setIndustries(new Set(s.organization?.industries ?? []));
        if (!s.organization) setStep("team");
        else setStep(canManageTeam(s.user.role, s.user.isPlatformAdmin) ? "industries" : "done");
      })
      .catch((e: Error) => setError(e.message));
  }, [isLoading, capabilities, isAuthenticated, router]);

  // Pre-tick every suggestion whenever the industries change.
  useEffect(() => setPicked(new Set(suggestions.map((s) => s.id))), [suggestions]);

  async function joinOrCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await call<State>("/api/onboarding", {
        method: "POST",
        body: JSON.stringify(mode === "create" ? { action: "create_org", name: orgName } : { action: "join_org", code }),
      });
      setState(s);
      setStep(canManageTeam(s.user.role, s.user.isPlatformAdmin) ? "industries" : "done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  async function importPersonas() {
    setBusy(true);
    setError("");
    try {
      const r = await call<{ added: number }>("/api/personas/import", {
        method: "POST",
        body: JSON.stringify({ industries: [...industries], libraryIds: [...picked] }),
      });
      setImported(r.added);
      await syncTeamPersonas();
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import the personas.");
    } finally {
      setBusy(false);
    }
  }

  async function finish(to: string) {
    setBusy(true);
    setError("");
    try {
      await call<State>("/api/onboarding", { method: "POST", body: JSON.stringify({ action: "finish" }) });
      finishOnboarding();
      router.push(to);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish setup.");
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    apply(next);
  };

  const inviteLink = state?.organization && typeof window !== "undefined"
    ? `${window.location.origin}/register?code=${state.organization.code}${state.user.role === "manager" ? `&manager=${state.user.id}` : ""}`
    : "";

  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* the link is shown to copy by hand */ }
  }

  if (!state) {
    return error ? <div className="page"><p role="alert" className="banner-warn">{error}</p></div> : <PageSkeleton rows={3} />;
  }

  const steps: Step[] = manages ? ["team", "industries", "personas", "done"] : ["team", "done"];
  const stepLabel: Record<Step, string> = { team: "Your team", industries: "Industries", personas: "Personas", done: "Ready" };

  return (
    <div className="page enter mx-auto max-w-3xl space-y-6">
      <div>
        <p className="eyebrow">Set up</p>
        <h1 className="mt-1 text-3xl font-bold">{state.user.firstName ? `Welcome, ${state.user.firstName}` : "Welcome"}</h1>
        <ol className="mt-4 flex flex-wrap gap-2" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li key={s} aria-current={s === step ? "step" : undefined}
              className={`chip ${s === step ? "!border-primary !text-primary" : steps.indexOf(step) > i ? "!text-ink" : ""}`}>
              {steps.indexOf(step) > i ? <Check size={12} strokeWidth={1.75} aria-hidden /> : <span className="mono">{i + 1}</span>} {stepLabel[s]}
            </li>
          ))}
        </ol>
      </div>

      {error && <p role="alert" className="banner-warn">{error}</p>}

      {step === "team" && (
        <form onSubmit={joinOrCreate} className="card space-y-4">
          <h2 className="text-lg font-bold">Start a team or join one</h2>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-sunken p-1 text-sm font-semibold">
            {(["create", "join"] as const).map((m) => (
              <button type="button" key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`min-h-[40px] rounded-lg ${mode === m ? "bg-surface text-primary shadow-sm" : "text-ink-muted"}`}>
                {m === "create" ? "New team" : "Join with a code"}
              </button>
            ))}
          </div>
          {mode === "create" ? (
            <div>
              <label htmlFor="org" className="label">Team or company name</label>
              <input id="org" className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} required minLength={2} maxLength={120} />
              <p className="mt-1 text-xs text-ink-muted">You&rsquo;ll be the owner. You can add managers and reps next.</p>
            </div>
          ) : (
            <div>
              <label htmlFor="code" className="label">Team code</label>
              <input id="code" className="input" inputMode="numeric" pattern="[0-9]{3,8}" value={code} onChange={(e) => setCode(e.target.value)} required />
              <p className="mt-1 text-xs text-ink-muted">Your manager can find it on their Team page.</p>
            </div>
          )}
          <button className="btn-primary w-full sm:w-auto" disabled={busy}>{busy ? "Saving…" : "Continue"}</button>
        </form>
      )}

      {step === "industries" && (
        <section className="card space-y-4" aria-labelledby="ind-h">
          <div>
            <h2 id="ind-h" className="text-lg font-bold">What does your team sell?</h2>
            <p className="mt-1 text-sm text-ink-soft">Pick one or more. We&rsquo;ll suggest practice personas that match.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {JOB_FAMILIES.map((f) => {
              const on = industries.has(f.id);
              return (
                <button key={f.id} type="button" aria-pressed={on} onClick={() => toggle(industries, f.id, setIndustries)}
                  className={`chip min-h-[36px] !px-3 !text-sm ${on ? "!border-primary !bg-primary-soft !text-primary" : ""}`}>
                  {on && <Check size={13} strokeWidth={1.75} aria-hidden />} {f.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={!industries.size} onClick={() => setStep("personas")}>Continue</button>
            <button type="button" className="btn-quiet" onClick={() => setStep("done")}>Skip for now</button>
          </div>
        </section>
      )}

      {step === "personas" && (
        <section className="card space-y-4" aria-labelledby="per-h">
          <div>
            <h2 id="per-h" className="text-lg font-bold">Import personas for your team</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {suggestions.length} personas match {[...industries].map(jobFamilyLabel).join(", ")}. Untick any you don&rsquo;t want. Everyone on your team will see these in their library.
            </p>
          </div>
          <ul className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-panel border border-line">
            {suggestions.map((s) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-sunken">
                  <input type="checkbox" className="mt-1" checked={picked.has(s.id)} onChange={() => toggle(picked, s.id, setPicked)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{s.aiPersona.name} <span className="font-normal text-ink-muted">· {s.difficulty}</span></span>
                    <span className="block text-[13px] text-ink-soft">{s.title}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy || !picked.size} onClick={importPersonas}>
              {busy ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : null} Import {picked.size} personas
            </button>
            <button type="button" className="btn-ghost" onClick={() => setStep("industries")}>Back</button>
          </div>
          <div className="border-t border-line pt-4">
            <p className="text-sm text-ink-soft">Need something specific to your product? Build your own from a job description, product page or CRM notes, then save it to your team.</p>
            <Link href="/library/new" className="btn-ghost mt-3"><Sparkles size={15} strokeWidth={1.75} aria-hidden /> Create your own persona</Link>
          </div>
        </section>
      )}

      {step === "done" && state.organization && (
        <section className="card space-y-4" aria-labelledby="done-h">
          <h2 id="done-h" className="text-lg font-bold">You&rsquo;re set up on {state.organization.name}</h2>
          {imported !== null && <p className="text-sm text-ink-soft">Added {imported} personas to your team&rsquo;s library.</p>}
          {manages ? (
            <>
              <div>
                <p className="label">Invite your reps</p>
                <p className="text-sm text-ink-soft">
                  Share this link. {state.user.role === "manager" ? "Reps who sign up with it land on your team." : "Reps who sign up with it join your organization; place them under a manager on the Team page."}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="mono min-w-0 flex-1 break-all rounded-lg bg-sunken px-3 py-2 text-xs">{inviteLink}</code>
                  <button type="button" className="btn-ghost btn-sm" onClick={copyInvite}><Copy size={14} strokeWidth={1.75} aria-hidden /> {copied ? "Copied" : "Copy"}</button>
                </div>
                <p className="mt-1 text-xs text-ink-muted">Team code: <span className="mono">{state.organization.code}</span></p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => finish("/team")}><Users size={15} strokeWidth={1.75} aria-hidden /> Go to my team</button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => finish("/trainer")}>Practise a call first</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                {state.manager ? `You're on ${state.manager.name}'s team. ` : ""}Your own scores and progress live on your dashboard. {state.manager ? "Your manager" : "Your managers"} can see how you&rsquo;re doing and assign practice.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={busy} onClick={() => finish("/trainer")}>Start practising</button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => finish("/dashboard")}>See my dashboard</button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
