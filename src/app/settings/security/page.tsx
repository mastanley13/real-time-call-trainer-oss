"use client";

import { PageSkeleton } from "@/components/ui/Skeleton";
import React, { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff, AlertTriangle, CheckCircle2, Info, KeyRound, RefreshCw } from "lucide-react";
import { useAuth } from "../../../contexts/AuthContext";
import SettingsNav from "@/components/settings/SettingsNav";
import RecoveryCodesPanel from "@/components/settings/RecoveryCodesPanel";
import { RECOVERY_CODE_COUNT, recoveryCodesLabel, recoveryCodesLow } from "@/lib/mfaRecovery-types";

type RecoveryCounts = { remaining: number; total: number };

/** The route's human message when it sent one, else its error text. */
async function errorText(r: Response, fallback: string): Promise<string> {
  const data = await r.json().catch(() => ({}));
  return data.message || data.error || fallback;
}

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

export default function SecuritySettingsPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, capabilities } = useAuth();
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
  // Plaintext codes from the one response that carries them. Cleared when the user dismisses the panel.
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [recovery, setRecovery] = useState<RecoveryCounts | null>(null);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [regenMethod, setRegenMethod] = useState<"password" | "code">("password");
  const [regenSecret, setRegenSecret] = useState("");

  const loadRecovery = useCallback(async () => {
    setRecoveryFailed(false);
    try {
      const r = await fetch("/api/auth/mfa/recovery-codes", { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      setRecovery(await r.json());
    } catch {
      setRecoveryFailed(true);
    }
  }, []);

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

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated && !noAccount) loadMe();
  }, [isAuthenticated, noAccount, loadMe]);

  useEffect(() => {
    if (me?.mfaEnabled) loadRecovery();
    else setRecovery(null);
  }, [me?.mfaEnabled, loadRecovery]);

  useEffect(() => {
    if (!enroll?.provisioningUri) return;
    QRCode.toDataURL(enroll.provisioningUri, { margin: 1, width: 240 })
      .then(setQrDataUri)
      .catch((e) => setError(e.message));
  }, [enroll?.provisioningUri]);

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/auth/mfa/enroll", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).error || "Failed");
      setEnroll(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start enrollment");
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/mfa/activate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw new Error(await errorText(r, "Invalid code"));
      const data: { recoveryCodes?: string[] } = await r.json();
      setEnroll(null);
      setCode("");
      setFreshCodes(data.recoveryCodes ?? null);
      setNotice("MFA is now enabled on this account.");
      await loadMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/mfa/disable", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw new Error(await errorText(r, "Invalid code"));
      setCode("");
      setFreshCodes(null);
      setNotice("MFA disabled. Your recovery codes no longer work.");
      await loadMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/auth/mfa/recovery-codes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regenMethod === "password" ? { password: regenSecret } : { code: regenSecret }),
      });
      if (!r.ok) throw new Error(await errorText(r, "Could not regenerate recovery codes. Try again."));
      const data: { recoveryCodes: string[] } = await r.json();
      setRegenSecret("");
      setFreshCodes(data.recoveryCodes);
      setNotice("New recovery codes are ready. Your old codes no longer work.");
      await loadRecovery();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not regenerate recovery codes. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const regenReady = regenMethod === "password" ? regenSecret.length > 0 : regenSecret.length === 6;

  if (noAccount || (!me && loadFailed)) {
    return (
      <div className="min-h-screen bg-sunken">
        <div className="max-w-2xl mx-auto p-4 sm:p-8">
          <SettingsNav className="mb-6" />
          <header className="mb-6">
            <p className="eyebrow">Security</p>
            <h1 className="text-2xl font-bold text-ink">Multi-factor authentication</h1>
          </header>
          <section className="card flex items-start gap-3">
            {noAccount ? <Info size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden /> : <AlertTriangle size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />}
            <div className="text-sm text-ink-soft">
              {noAccount ? (
                <p>MFA protects stored accounts, and this install has none: {capabilities?.demoMode ? "demo mode skips sign-in and keeps sessions in this browser." : "no database is configured."} Set DATABASE_URL and turn off DEMO_MODE to use it.</p>
              ) : (
                <>
                  <p>We couldn&apos;t load your account settings. Check your connection, then try again. If it keeps failing, sign out and sign in again.</p>
                  <button type="button" onClick={loadMe} className="btn-ghost btn-sm mt-3">Try again</button>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="min-h-screen bg-sunken">
        <div className="max-w-2xl mx-auto px-4 pt-4 sm:px-8 sm:pt-8"><SettingsNav /></div>
        <PageSkeleton rows={2} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sunken">
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <SettingsNav className="mb-6" />
        <header className="mb-6">
          <p className="eyebrow">Security</p>
          <h1 className="text-2xl font-bold text-ink">
            Multi-factor authentication
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Protect your account with a time-based authentication code from
            an app like 1Password, Authy, or Google Authenticator.
          </p>
        </header>

        {error && (
          // Ink text on alert-soft: alert-colored text measures under 4.5:1 here.
          <div role="alert" className="mb-4 rounded-lg border border-alert/40 bg-alert-soft text-ink px-3 py-2 text-sm flex items-start gap-2">
            <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div role="status" className="mb-4 rounded-lg bg-ok-soft text-ok border border-ok/40 px-3 py-2 text-sm flex items-start gap-2">
            <CheckCircle2 size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <span>{notice}</span>
          </div>
        )}

        {freshCodes && (
          <RecoveryCodesPanel codes={freshCodes} account={me.email} onDone={() => setFreshCodes(null)} />
        )}

        <section className="bg-surface border border-line rounded-2xl p-5">
          {me.mfaEnabled ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-5 h-5 text-ok" />
                <h2 className="text-sm font-semibold text-ink">
                  MFA is enabled
                </h2>
              </div>
              <p className="text-sm text-ink-muted mb-4">
                Enrolled{" "}
                {me.mfaEnrolledAt
                  ? new Date(me.mfaEnrolledAt).toLocaleString()
                  : ""}
                . To disable MFA, enter a current authenticator code below.
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="mfa-disable-code" className="label">
                    Authenticator code
                  </label>
                  <input
                    id="mfa-disable-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="input tracking-[0.5em] text-center font-mono"
                    placeholder="000000"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || code.length !== 6}
                  onClick={disable}
                  className="btn-danger"
                >
                  <ShieldOff size={16} strokeWidth={1.75} aria-hidden /> Disable MFA
                </button>
              </div>
            </>
          ) : enroll ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-5 h-5 text-ink-soft" />
                <h2 className="text-sm font-semibold text-ink">
                  Finish enrollment
                </h2>
              </div>
              <ol className="text-sm text-ink-soft space-y-2 mb-4 list-decimal list-inside">
                <li>Open your authenticator app.</li>
                <li>Scan the QR code below (or paste the secret manually).</li>
                <li>Enter the 6-digit code the app shows you.</li>
              </ol>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {qrDataUri ? (
                  // A generated data: URI; next/image has nothing to optimize here.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrDataUri}
                    alt="MFA QR code"
                    className="w-48 h-48 border border-line rounded-lg bg-surface"
                  />
                ) : (
                  <div className="w-48 h-48 border border-dashed border-line rounded-lg flex items-center justify-center text-ink-muted text-xs">
                    Generating QR…
                  </div>
                )}
                <div className="text-xs text-ink-muted">
                  <p className="font-medium text-ink-soft mb-1">
                    Manual entry
                  </p>
                  <p className="font-mono break-all text-[11px] bg-sunken border border-line rounded px-2 py-1">
                    {enroll.secret}
                  </p>
                  <p className="mt-2">Issuer: {enroll.issuer}</p>
                  <p>Account: {enroll.label}</p>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="mfa-enroll-code" className="label">
                    Authenticator code
                  </label>
                  <input
                    id="mfa-enroll-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="input tracking-[0.5em] text-center font-mono"
                    placeholder="000000"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || code.length !== 6}
                  onClick={activate}
                  className="btn-primary"
                >
                  Verify & enable
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEnroll(null);
                  setCode("");
                  setQrDataUri(null);
                }}
                className="btn-quiet btn-sm mt-3"
              >
                Cancel enrollment
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldOff className="w-5 h-5 text-ink-muted" />
                <h2 className="text-sm font-semibold text-ink">
                  MFA is off
                </h2>
              </div>
              <p className="text-sm text-ink-muted mb-4">
                Once enabled, sign-ins to this account will require a 6-digit
                code from your authenticator app.
              </p>
              <button
                type="button"
                onClick={startEnroll}
                disabled={busy}
                className="btn-primary"
              >
                <ShieldCheck size={16} strokeWidth={1.75} aria-hidden /> Enable MFA
              </button>
            </>
          )}
        </section>

        {me.mfaEnabled && (
          <section aria-labelledby="recovery-title" className="bg-surface border border-line rounded-2xl p-5 mt-4">
            <div className="flex items-center gap-2 mb-3">
              <KeyRound size={20} strokeWidth={1.75} className="text-ink-soft" aria-hidden />
              <h2 id="recovery-title" className="text-sm font-semibold text-ink">
                Recovery codes
              </h2>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              If you lose your authenticator app, sign in with one of these single-use codes instead.
            </p>

            {recovery ? (
              recoveryCodesLow(recovery.remaining) ? (
                <div className="banner-warn mb-4 flex items-start gap-2">
                  <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-caution" aria-hidden />
                  <span>
                    <strong className="font-semibold">
                      {recovery.total === 0 ? "No recovery codes yet" : recoveryCodesLabel(recovery.remaining)}
                    </strong>
                    {recovery.total === 0
                      ? `. Generate a set of ${RECOVERY_CODE_COUNT} below so you can still sign in without your app.`
                      : ". Regenerate them below before you run out."}
                  </span>
                </div>
              ) : (
                <p className="mb-4 flex items-center gap-2 text-sm text-ink">
                  <ShieldCheck size={16} strokeWidth={1.75} className="shrink-0 text-ok" aria-hidden />
                  {recoveryCodesLabel(recovery.remaining)}
                </p>
              )
            ) : recoveryFailed ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                <span>We couldn&apos;t load your recovery code count.</span>
                <button type="button" onClick={loadRecovery} className="btn-quiet btn-sm">
                  Try again
                </button>
              </div>
            ) : (
              <div className="skeleton h-5 w-48 mb-4" aria-hidden />
            )}

            <form onSubmit={regenerate}>
              <fieldset className="mb-3">
                <legend className="label">Confirm it&apos;s you with</legend>
                <div className="inline-flex rounded-lg border border-line p-0.5" role="group">
                  {(["password", "code"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={regenMethod === m}
                      onClick={() => {
                        setRegenMethod(m);
                        setRegenSecret("");
                      }}
                      className="btn-quiet btn-sm aria-pressed:bg-sunken aria-pressed:text-ink"
                    >
                      {m === "password" ? "Password" : "Authenticator code"}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="regen-secret" className="label">
                    {regenMethod === "password" ? "Current password" : "Authenticator code"}
                  </label>
                  {regenMethod === "password" ? (
                    <input
                      id="regen-secret"
                      type="password"
                      autoComplete="current-password"
                      maxLength={200}
                      value={regenSecret}
                      onChange={(e) => setRegenSecret(e.target.value)}
                      className="input"
                    />
                  ) : (
                    <input
                      id="regen-secret"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={regenSecret}
                      onChange={(e) => setRegenSecret(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="input tracking-[0.5em] text-center font-mono"
                      placeholder="000000"
                    />
                  )}
                </div>
                <button type="submit" disabled={busy || !regenReady} className="btn-ghost">
                  <RefreshCw size={16} strokeWidth={1.75} aria-hidden /> Regenerate codes
                </button>
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                Regenerating replaces all of your codes. Codes you saved earlier stop working.
              </p>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
