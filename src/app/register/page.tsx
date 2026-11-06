"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import GoogleButton, { GOOGLE_ERRORS } from "@/components/GoogleButton";
import LegalLinks from "@/components/LegalLinks";
import { EXAMPLE_CUE, EXAMPLE_PERSONA, EXAMPLE_TURNS } from "@/components/landing/HeroDeck";
import { afterSignin, intentFromQuery, rememberNotice } from "@/lib/checkoutStart";
import { planSummary } from "@/lib/pricing";
import {
  accessHref, clearDraft, createSubmitter, EMAIL_MAX, EMPTY_VALUES, FIELD_IDS, FREE_SIGNUP_LINE, loadDraft, NAME_MAX,
  PASSWORD_HELP, PASSWORD_MAX, PASSWORD_MIN, saveDraft, summaryItems, TEAM_NAME_MAX,
  type FieldErrors, type MappedError, type RegisterField, type RegisterValues, type WorkspaceMode,
} from "@/lib/registerForm";

export default function RegisterPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

/** Sentence-case label, help and error styles for this form. Colors are tokens only. */
const LABEL = "mb-2 block text-base font-semibold leading-6 text-ink";
const HELP = "mt-2 text-sm leading-5 text-ink-soft";
const ERROR = "mt-2 text-sm font-medium leading-5 text-alert";
/** .input with the shared 48 px control height and the 3 px / 4 px focus ring (.input turns the outline off otherwise). */
const INPUT =
  "input min-h-[48px] text-base focus-visible:outline focus-visible:outline-primary focus-visible:[outline-offset:var(--focus-ring-offset)] focus-visible:[outline-width:var(--focus-ring-width)]";

const WORKSPACE_OPTIONS: { value: WorkspaceMode; label: string; desc: string }[] = [
  { value: "create", label: "Start a new team", desc: "You own this workspace. Practicing solo? It is simply where your practice is stored." },
  { value: "join", label: "Join a team with a code", desc: "Your manager or team owner gives you the team code." },
];

function RegisterForm() {
  const { register, isAuthenticated, capabilities, capabilitiesFailed } = useAuth();
  // The billing state is known once /api/config answers. If it answers with an error (no access cookie behind the
  // access gate), billing reads as off and sign-up stays possible; the register API still enforces the gate.
  const configKnown = capabilities !== null || capabilitiesFailed;
  const router = useRouter();
  const params = useSearchParams();
  // The link's plan, period, src and seg, whitelisted. Anything else in the query is dropped.
  const intent = intentFromQuery(useSearchParams());
  const summary = planSummary(intent);
  const billingEnabled = capabilities?.billing === true;
  const intentQs = new URLSearchParams(Object.entries(intent) as [string, string][]).toString();
  const registerPath = intentQs ? `/register?${intentQs}` : "/register";

  /** Billing on with a plan goes to checkout; otherwise /trainer, with a one-time notice when a plan was asked for. */
  function goAfterSignin() {
    const next = afterSignin(billingEnabled, intent);
    if (next.notice) rememberNotice(next.notice);
    router.replace(next.path);
  }

  const [mode, setMode] = useState<WorkspaceMode>("create");
  const [values, setValues] = useState<RegisterValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<FieldErrors>({});
  // A Google sign-in that failed can come back with ?error=; show it in the summary until the next submit.
  const [formError, setFormError] = useState<MappedError | null>(() => {
    const code = params.get("error");
    if (!code) return null;
    // Own keys only, so ?error=__proto__ or ?error=toString falls back to the generic message.
    return { message: Object.prototype.hasOwnProperty.call(GOOGLE_ERRORS, code) ? GOOGLE_ERRORS[code] : GOOGLE_ERRORS.google_failed };
  });
  const [busy, setBusy] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const registerRef = useRef(register);
  const submitRef = useRef<ReturnType<typeof createSubmitter> | null>(null);

  useEffect(() => {
    registerRef.current = register;
  });

  // Already signed in: record nothing new, follow the billing state. Wait for the capabilities so the state is known.
  useEffect(() => {
    if (isAuthenticated && configKnown) goAfterSignin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, configKnown]);

  // Coming back (browser back, or from Terms or Sign in): restore the draft. Drop ?error= from the address bar.
  useEffect(() => {
    const d = loadDraft();
    if (d) {
      setMode(d.mode);
      setValues((v) => ({ ...v, ...d.values }));
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has("error")) {
      url.searchParams.delete("error");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
    }
  }, []);

  // After a failed submit, move focus to the error summary so it is read out and each problem is one link away.
  useEffect(() => {
    if (focusTick) summaryRef.current?.focus();
  }, [focusTick]);

  const setField = (k: RegisterField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...values, [k]: e.target.value };
    setValues(next);
    saveDraft(mode, next);
    if (errors[k]) setErrors((prev) => ({ ...prev, [k]: undefined }));
  };

  function switchMode(m: WorkspaceMode) {
    // The radios are disabled while a request runs; this guards a change that slips through anyway.
    if (busy) return;
    setMode(m);
    saveDraft(m, values);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The billing state decides where a new account goes, so wait until /api/config has answered.
    if (!configKnown) return;
    submitRef.current ??= createSubmitter(
      (payload) => registerRef.current(payload),
      (pending) => {
        setBusy(pending);
        if (pending) {
          setErrors({});
          setFormError(null);
        }
      },
    );
    const out = await submitRef.current(values, mode, intent);
    if (out.kind === "ignored") return;
    if (out.kind === "ok") {
      clearDraft();
      goAfterSignin();
      return;
    }
    if (out.kind === "invalid") {
      setErrors(out.errors);
      setFormError(null);
    } else if (out.error.field) {
      setErrors({ [out.error.field]: out.error.message });
      setFormError(null);
    } else {
      setErrors({});
      setFormError(out.error);
    }
    setFocusTick((n) => n + 1);
  }

  function jumpTo(field: RegisterField) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      document.getElementById(FIELD_IDS[field])?.focus();
    };
  }

  const items = summaryItems(errors, mode);
  const showSummary = items.length > 0 || formError !== null;

  /** Label, help and error wiring shared by every input. */
  const wire = (f: RegisterField, helpId: string) => {
    const err = errors[f];
    return {
      id: FIELD_IDS[f],
      name: f,
      value: values[f],
      onChange: setField(f),
      required: true,
      "aria-invalid": err ? (true as const) : undefined,
      "aria-describedby": err ? `${helpId} ${FIELD_IDS[f]}-error` : helpId,
      className: INPUT,
    };
  };
  const fieldError = (f: RegisterField) =>
    errors[f] ? <p id={`${FIELD_IDS[f]}-error`} className={ERROR}><span className="sr-only">Error: </span>{errors[f]}</p> : null;

  return (
    <div className="focus-strong text-base leading-6">
      <div className="site-wrap">
        <div className="mx-auto grid max-w-[560px] gap-12 py-10 md:py-16 lg:max-w-none lg:grid-cols-[minmax(0,460px)_minmax(0,460px)] lg:justify-center lg:gap-x-16 xl:gap-x-24">
          <section aria-labelledby="signup-h" className="flex min-w-0 flex-col gap-6">
            <div className="flex flex-col gap-3">
              <h1 id="signup-h" className="text-[32px] font-bold leading-[1.15] sm:text-[40px] sm:leading-[1.1]">
                Create your account. <span className="text-ink-soft">Start practicing.</span>
              </h1>
              <p className="text-ink-soft">Start a team workspace, or join one with the team code your manager shares.</p>
              <p className="text-sm leading-5 text-ink-soft">{FREE_SIGNUP_LINE}</p>
            </div>

            {capabilities && !capabilities.database && !capabilities.demoMode && (
              <p className="banner-warn">Sign-up is not available on this server yet because accounts are not set up. Ask the person who runs it, or try again later.</p>
            )}
            {capabilitiesFailed && (
              <p className="rounded-panel border border-line bg-sunken p-4 text-sm leading-5 text-ink">
                This server may be invite-only. If you were given an access code,{" "}
                <Link href={accessHref(registerPath)} className="font-semibold text-primary underline underline-offset-4">enter it first</Link>{" "}
                so your account can be created.
              </p>
            )}

            {summary && (
              <div className="panel p-4">
                <p className="text-sm font-semibold text-ink-soft">Your plan</p>
                <p className="mt-1 font-heading text-lg font-semibold">{summary.name}, {summary.periodLabel}</p>
                <p className="text-sm text-ink-soft">{summary.price}</p>
                {summary.seats && <p className="text-sm text-ink-soft">{summary.seats}</p>}
                {billingEnabled && <p className="mt-2 text-sm text-ink-soft">You pay at checkout, right after you create your account.</p>}
              </div>
            )}

            {showSummary && (
              <div
                ref={summaryRef}
                tabIndex={-1}
                aria-labelledby="reg-summary-h"
                className="rounded-panel border-2 border-alert bg-surface p-4"
              >
                <h2 id="reg-summary-h" className="text-base font-bold leading-6">
                  {items.length > 0 ? "Check these details" : "Your account was not created"}
                </h2>
                {formError && (
                  <p className="mt-1 text-sm leading-5 text-ink">
                    {formError.message}
                    {formError.accessLink && (
                      <>
                        {" "}
                        <Link href={accessHref(registerPath)} className="font-semibold text-primary underline underline-offset-4">Enter the access code</Link>
                      </>
                    )}
                  </p>
                )}
                {items.length > 0 && (
                  <ul className="mt-2 flex list-none flex-col gap-1">
                    {items.map((it) => (
                      <li key={it.field}>
                        {it.linked ? (
                          <a href={`#${FIELD_IDS[it.field]}`} onClick={jumpTo(it.field)} className="text-sm font-medium leading-5 text-alert underline underline-offset-4">
                            {it.message}
                          </a>
                        ) : (
                          // The field is hidden by the current workspace choice, so there is nothing to link to.
                          <span className="text-sm font-medium leading-5 text-alert">{it.message}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* The shared Google button is 40 px; this page uses the 48 px control height. Behavior is unchanged. */}
            <div className="[&>a]:min-h-[48px] [&>a]:text-base">
              <GoogleButton carryIntent />
            </div>

            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <div className="grid gap-5 lg:grid-cols-2 lg:gap-4">
                  <div className="min-w-0">
                    <label htmlFor={FIELD_IDS.firstName} className={LABEL}>First name</label>
                    <input {...wire("firstName", "reg-name-help")} autoComplete="given-name" maxLength={NAME_MAX} />
                    {fieldError("firstName")}
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={FIELD_IDS.lastName} className={LABEL}>Last name</label>
                    <input {...wire("lastName", "reg-name-help")} autoComplete="family-name" maxLength={NAME_MAX} />
                    {fieldError("lastName")}
                  </div>
                </div>
                <p id="reg-name-help" className="text-sm leading-5 text-ink-soft">Your team sees this name next to your practice.</p>
              </div>

              <div>
                <label htmlFor={FIELD_IDS.email} className={LABEL}>Email</label>
                <input {...wire("email", "reg-email-help")} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={EMAIL_MAX} />
                <p id="reg-email-help" className={HELP}>You sign in with this email.</p>
                {fieldError("email")}
              </div>

              <div>
                <label htmlFor={FIELD_IDS.password} className={LABEL}>Password</label>
                <input {...wire("password", "reg-password-help")} type="password" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} />
                <p id="reg-password-help" className={HELP}>{PASSWORD_HELP}</p>
                {fieldError("password")}
              </div>

              <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby="reg-workspace-help">
                <legend className="block text-base font-semibold leading-6 text-ink">Practice workspace</legend>
                <p id="reg-workspace-help" className="mt-1 text-sm leading-5 text-ink-soft">
                  Your calls and debriefs are stored in a workspace. Joining an existing team needs its team code.
                </p>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {WORKSPACE_OPTIONS.map((o) => (
                    <div
                      key={o.value}
                      className="relative flex min-h-[48px] min-w-0 items-start gap-3 rounded-control border border-line bg-surface p-3 hover:border-ink-muted/50 has-[:checked]:border-primary has-[:checked]:bg-sunken has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                    >
                      <input
                        type="radio"
                        id={`reg-workspace-${o.value}`}
                        name="workspace"
                        value={o.value}
                        checked={mode === o.value}
                        onChange={() => switchMode(o.value)}
                        disabled={busy}
                        aria-describedby={`reg-workspace-${o.value}-desc`}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                      />
                      <div className="min-w-0">
                        {/* The label's overlay makes the whole option clickable without folding the description into its name. */}
                        <label htmlFor={`reg-workspace-${o.value}`} className="cursor-pointer font-semibold leading-6 text-ink after:absolute after:inset-0 after:content-['']">
                          {o.label}
                        </label>
                        <p id={`reg-workspace-${o.value}-desc`} className="text-sm leading-5 text-ink-soft">{o.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>

              {mode === "create" ? (
                <div>
                  <label htmlFor={FIELD_IDS.orgName} className={LABEL}>Team name</label>
                  <input {...wire("orgName", "reg-team-name-help")} autoComplete="organization" maxLength={TEAM_NAME_MAX} />
                  <p id="reg-team-name-help" className={HELP}>Practicing alone? Your own name works, for example Jordan&rsquo;s practice.</p>
                  {fieldError("orgName")}
                </div>
              ) : (
                <div>
                  <label htmlFor={FIELD_IDS.orgCode} className={LABEL}>Team code</label>
                  <input {...wire("orgCode", "reg-team-code-help")} inputMode="numeric" autoComplete="off" maxLength={8} />
                  <p id="reg-team-code-help" className={HELP}>3 to 8 digits. You join the team as a trainee.</p>
                  {fieldError("orgCode")}
                </div>
              )}

              <button
                type="submit"
                className="btn-primary btn-lg w-full"
                disabled={!configKnown}
                aria-disabled={busy || undefined}
              >
                {busy ? (
                  <>
                    <Loader2 size={18} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    Creating account
                  </>
                ) : (
                  "Create account"
                )}
              </button>
              <p role="status" className="sr-only">{busy ? "Creating your account." : ""}</p>
            </form>

            <div>
              <p className="text-sm leading-5 text-ink-soft">
                Already registered? <Link href="/login" className="font-semibold text-primary underline underline-offset-4">Sign in</Link>
              </p>
              <LegalLinks />
            </div>
          </section>

          <aside aria-labelledby="preview-h" className="flex min-w-0 flex-col gap-6 border-t border-line pt-10 lg:border-t-0 lg:pt-12">
            <h2 id="preview-h" className="max-w-[20ch] text-2xl font-bold leading-8">Your first practice starts with a buyer.</h2>

            <div className="min-w-0 overflow-hidden rounded-panel border border-line bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line bg-sunken/40 px-5 py-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold leading-7">
                    <span className="sr-only">Example session with </span>{EXAMPLE_PERSONA.name}
                  </h3>
                  <p className="text-sm leading-5 text-ink-soft">{EXAMPLE_PERSONA.context}</p>
                </div>
                <span className="badge-tag" aria-hidden="true">Example session</span>
              </div>
              <div className="flex flex-col gap-5 p-5">
                <ol role="list" aria-label="Example transcript" className="flex list-none flex-col gap-5">
                  {EXAMPLE_TURNS.map((t) => (
                    <li key={t.at} className="grid grid-cols-[48px_minmax(0,1fr)] gap-3">
                      <p className="text-sm leading-5">
                        <span className="block font-semibold text-ink">{t.speaker}</span>
                        <span className="sr-only">, {t.role}, at </span>
                        <span className="block tabular-nums text-ink-soft">{t.at}</span>
                      </p>
                      <p className="break-words text-lg leading-7 text-ink">{t.text}</p>
                    </li>
                  ))}
                </ol>
                <div role="note" aria-label="Coach cue" className="rounded-r-control border-l-4 border-primary bg-sunken p-4">
                  <p className="text-sm font-semibold leading-5 text-ink">Coach cue: {EXAMPLE_CUE.title.toLowerCase()}</p>
                  <p className="mt-1 text-base leading-6 text-ink">{EXAMPLE_CUE.message}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="font-semibold text-ink">After you create your account</p>
              <p className="text-ink-soft">
                {summary && billingEnabled ? "Checkout comes first for your plan. Then you" : "You"} pick a buyer and read the brief. Talk or type, then review feedback that quotes your own words.
              </p>
              <p className="text-sm leading-5 text-ink-soft">Your browser asks for microphone access only when you start a voice call, never on this page.</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
