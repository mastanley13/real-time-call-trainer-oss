"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { AlertTriangle, CheckCircle2, Info, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import SettingsNav from "@/components/settings/SettingsNav";
import { Skeleton } from "@/components/ui/Skeleton";

type MeResponse = {
  user: {
    id: string;
    email: string;
    mfaEnabled: boolean;
    mfaEnrolledAt: string | null;
  };
};

type EnrollResponse = {
  secret: string;
  provisioningUri: string;
  label: string;
  issuer: string;
};

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

/** The MFA routes answer with short internal phrases; show a sentence that says what happened and what to do. */
function mfaErrorText(status: number, raw: string | undefined, fallback: string): string {
  const msg = (raw ?? "").toLowerCase();
  if (status === 429 || msg.includes("rate limit")) return "Too many attempts. Wait a minute, then try again.";
  if (msg.includes("invalid code")) return "That code didn't match. Enter the current 6-digit code from your authenticator app. Codes change every 30 seconds.";
  if (msg.includes("no enrollment")) return "This setup expired. Start again with Enable MFA.";
  if (msg.includes("already enabled")) return "MFA is already on for this account. Reload the page to see it.";
  if (msg.includes("not enabled")) return "MFA is already off for this account. Reload the page to see it.";
  if (msg.includes("unknown user")) return "We couldn't find your account. Sign out, then sign in again.";
  if (status === 401) return "Your session expired. Sign in again to change MFA.";
  return fallback;
}

async function failure(r: Response, fallback: string): Promise<Error> {
  const data = await r.json().catch(() => ({}));
  return new Error(mfaErrorText(r.status, typeof data.error === "string" ? data.error : undefined, fallback));
}

const errorMessage = (e: unknown, fallback: string) => (e instanceof TypeError ? NETWORK_ERROR : e instanceof Error ? e.message : fallback);

/** A 6-digit code box, wide-tracked and centered so each digit reads like a readout. */
function CodeField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="label">Authenticator code</label>
      <input id={id} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="input text-center font-mono text-lg tracking-[0.5em]" placeholder="000000" />
    </div>
  );
}

export default function SecuritySettingsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, capabilities, capabilitiesFailed } = useAuth();
  // Demo mode and database-free installs have no stored account, so there is nothing to protect with MFA.
  const noAccount = !!capabilities && (capabilities.demoMode || !capabilities.database);
  const [me, setMe] = useState<MeResponse["user"] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [enroll, setEnroll] = useState<EnrollResponse | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    setLoadFailed(false);
    try {
      const r = await fetch("/api/me", { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      const data: MeResponse = await r.json();
      setMe(data.user);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  // Wait for /api/config before deciding: demo mode signs in only once capabilities arrive, and config errors should not trap the user.
  useEffect(() => {
    if ((capabilities || capabilitiesFailed) && !isLoading && !isAuthenticated) router.replace("/login");
  }, [capabilities, capabilitiesFailed, isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated && !noAccount) loadMe();
  }, [isAuthenticated, noAccount, loadMe]);

  useEffect(() => {
    if (!enroll?.provisioningUri) return;
    QRCode.toDataURL(enroll.provisioningUri, { margin: 1, width: 240 })
      .then(setQrDataUri)
      .catch(() => setError("Couldn't draw the QR code. Enter the secret by hand instead."));
  }, [enroll?.provisioningUri]);

  const startEnroll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/auth/mfa/enroll", { method: "POST", credentials: "include" });
      if (!r.ok) throw await failure(r, "Couldn't start MFA setup. Try again in a minute.");
      setEnroll(await r.json());
    } catch (e) {
      setError(errorMessage(e, "Couldn't start MFA setup. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/mfa/activate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw await failure(r, "Couldn't turn on MFA. Try again in a minute.");
      setEnroll(null);
      setCode("");
      setQrDataUri(null);
      setNotice("MFA is now on. Sign-ins to this account will ask for a code.");
      await loadMe();
    } catch (e) {
      setError(errorMessage(e, "Couldn't turn on MFA. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/mfa/disable", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw await failure(r, "Couldn't turn off MFA. Try again in a minute.");
      setCode("");
      setNotice("MFA is off. Sign-ins use your password only.");
      await loadMe();
    } catch (e) {
      setError(errorMessage(e, "Couldn't turn off MFA. Try again in a minute."));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <header>
      <p className="eyebrow">Settings</p>
      <h1 className="mt-1 text-3xl font-bold">Security</h1>
      <p className="mt-2 max-w-2xl text-ink-soft">Protect your account with a time-based code from an app like 1Password, Authy or Google Authenticator.</p>
    </header>
  );

  if (noAccount || capabilitiesFailed || (!me && loadFailed)) {
    return (
      <div className="page enter max-w-5xl space-y-6">
        <SettingsNav />
        {header}
        <section className="panel flex items-start gap-3 p-4 sm:p-5" role={noAccount ? undefined : "alert"}>
          {noAccount ? <Info size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden /> : <AlertTriangle size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />}
          <div className="text-sm text-ink-soft">
            {noAccount ? (
              <p>MFA protects stored accounts, and this install has none: {capabilities?.demoMode ? "demo mode skips sign-in and keeps sessions in this browser." : "no database is configured."} Set DATABASE_URL and turn off DEMO_MODE to use it.</p>
            ) : capabilitiesFailed ? (
              <>
                <p>We couldn&apos;t reach the server to check this installation&apos;s settings. Refresh the page and try again.</p>
                <button type="button" onClick={() => window.location.reload()} className="btn-ghost btn-sm mt-3">Refresh</button>
              </>
            ) : (
              <>
                <p>We couldn&apos;t load your account settings. Check your connection, then try again. If it keeps failing, sign out and sign in again.</p>
                <button type="button" onClick={loadMe} className="btn-ghost btn-sm mt-3">Try again</button>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }

  if ((!capabilities && !capabilitiesFailed) || !me) {
    return (
      <div className="page enter max-w-5xl space-y-6" role="status">
        <SettingsNav />
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-44 w-full" />
        <span className="sr-only">Loading security settings...</span>
      </div>
    );
  }

  const state = me.mfaEnabled ? "on" : enroll ? "setup" : "off";
  const lamp = { on: "lamp-ok", setup: "lamp-signal", off: "lamp-off" }[state];
  const StateIcon = me.mfaEnabled || enroll ? ShieldCheck : ShieldOff;

  return (
    <div className="page enter max-w-5xl space-y-6">
      <SettingsNav />
      {header}

      {error && (
        <div role="alert" className="banner-alert flex items-start gap-2">
          <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" className="banner-ok flex items-start gap-2">
          <CheckCircle2 size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />
          <span>{notice}</span>
        </div>
      )}

      <section className="panel p-4 sm:p-5" aria-labelledby="mfa-h">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-sunken">
              <StateIcon size={18} strokeWidth={1.75} className={me.mfaEnabled ? "text-ok" : "text-ink-muted"} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 id="mfa-h" className="font-heading text-base font-bold">Multi-factor authentication</h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                {me.mfaEnabled
                  ? <>Enrolled{me.mfaEnrolledAt ? <> <span className="mono">{new Date(me.mfaEnrolledAt).toLocaleDateString()}</span></> : null}. Sign-ins ask for a 6-digit code.</>
                  : enroll ? "Finish setup in your authenticator app." : "Sign-ins use your password only."}
              </p>
            </div>
          </div>
          <span className="chip-model"><span className={`lamp ${lamp} !h-1.5 !w-1.5`} aria-hidden />{state === "on" ? "On" : state === "setup" ? "Setting up" : "Off"}</span>
        </div>

        <div className="mt-5 border-t border-line pt-5">
          {me.mfaEnabled ? (
            <>
              <p className="mb-4 text-sm text-ink-soft">To turn MFA off, enter a current code from your authenticator app.</p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <CodeField id="mfa-disable-code" value={code} onChange={setCode} />
                <button type="button" disabled={!busy && code.length !== 6} aria-disabled={busy || undefined} onClick={disable} className="btn-danger">
                  {busy ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <ShieldOff size={16} strokeWidth={1.75} aria-hidden />}
                  {busy ? "Turning off" : "Disable MFA"}
                </button>
              </div>
            </>
          ) : enroll ? (
            <>
              <ol className="mb-5 list-inside list-decimal space-y-1.5 text-sm text-ink-soft">
                <li>Open your authenticator app.</li>
                <li>Scan the QR code below, or enter the secret by hand.</li>
                <li>Enter the 6-digit code the app shows you.</li>
              </ol>
              <div className="mb-5 flex flex-col gap-5 sm:flex-row">
                {qrDataUri ? (
                  // A generated data: URI; next/image has nothing to optimize here.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUri} alt="QR code for your authenticator app" className="h-48 w-48 shrink-0 rounded-lg border border-line bg-surface" />
                ) : (
                  <div className="skeleton h-48 w-48 shrink-0" role="status"><span className="sr-only">Generating the QR code...</span></div>
                )}
                <div className="min-w-0 text-xs text-ink-muted">
                  <p className="label">Manual entry</p>
                  <p className="break-all rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[12px] text-ink">{enroll.secret}</p>
                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt>Issuer</dt><dd className="truncate text-ink-soft">{enroll.issuer}</dd>
                    <dt>Account</dt><dd className="truncate text-ink-soft">{enroll.label}</dd>
                  </dl>
                </div>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <CodeField id="mfa-enroll-code" value={code} onChange={setCode} />
                <button type="button" disabled={!busy && code.length !== 6} aria-disabled={busy || undefined} onClick={activate} className="btn-primary">
                  {busy ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <ShieldCheck size={16} strokeWidth={1.75} aria-hidden />}
                  {busy ? "Verifying" : "Verify & enable"}
                </button>
              </div>
              <button type="button" onClick={() => { setEnroll(null); setCode(""); setQrDataUri(null); setError(null); }} className="btn-quiet btn-sm mt-3">
                Cancel setup
              </button>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-ink-soft">Once it is on, sign-ins to this account will ask for a 6-digit code from your authenticator app.</p>
              <button type="button" onClick={startEnroll} aria-disabled={busy || undefined} className="btn-primary">
                {busy ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <ShieldCheck size={16} strokeWidth={1.75} aria-hidden />}
                {busy ? "Starting" : "Enable MFA"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
