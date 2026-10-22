"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useAuth } from "../../../contexts/AuthContext";

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
  const { isAuthenticated, isLoading } = useAuth();
  const [me, setMe] = useState<MeResponse["user"] | null>(null);
  const [enroll, setEnroll] = useState<EnrollResponse | null>(null);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    const r = await fetch("/api/me", { credentials: "include" });
    if (!r.ok) return;
    const data: MeResponse = await r.json();
    setMe(data.user);
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (isAuthenticated) loadMe();
  }, [isAuthenticated, loadMe]);

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
      if (!r.ok) throw new Error((await r.json()).error || "Invalid code");
      setEnroll(null);
      setCode("");
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
      if (!r.ok) throw new Error((await r.json()).error || "Invalid code");
      setCode("");
      setNotice("MFA disabled.");
      await loadMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (!me) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-widest text-slate-500">
            Security
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            Multi-factor authentication
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Protect your account with a time-based authentication code from
            an app like 1Password, Authy, or Google Authenticator.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 px-3 py-2 text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-2 text-sm flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          {me.mfaEnabled ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <h2 className="text-sm font-semibold text-slate-900">
                  MFA is enabled
                </h2>
              </div>
              <p className="text-sm text-slate-600 mb-4">
                Enrolled{" "}
                {me.mfaEnrolledAt
                  ? new Date(me.mfaEnrolledAt).toLocaleString()
                  : ""}
                . To disable MFA, enter a current authenticator code below.
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Authenticator code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg tracking-[0.5em] text-center font-mono"
                    placeholder="000000"
                  />
                </div>
                <button
                  disabled={busy || code.length !== 6}
                  onClick={disable}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 text-white text-sm font-semibold disabled:opacity-60"
                >
                  <ShieldOff className="w-4 h-4" /> Disable MFA
                </button>
              </div>
            </>
          ) : enroll ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-5 h-5 text-slate-700" />
                <h2 className="text-sm font-semibold text-slate-900">
                  Finish enrollment
                </h2>
              </div>
              <ol className="text-sm text-slate-700 space-y-2 mb-4 list-decimal list-inside">
                <li>Open your authenticator app.</li>
                <li>Scan the QR code below (or paste the secret manually).</li>
                <li>Enter the 6-digit code the app shows you.</li>
              </ol>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                {qrDataUri ? (
                  <img
                    src={qrDataUri}
                    alt="MFA QR code"
                    className="w-48 h-48 border border-slate-200 rounded-lg bg-white"
                  />
                ) : (
                  <div className="w-48 h-48 border border-dashed border-slate-300 rounded-lg flex items-center justify-center text-slate-400 text-xs">
                    Generating QR…
                  </div>
                )}
                <div className="text-xs text-slate-600">
                  <p className="font-medium text-slate-700 mb-1">
                    Manual entry
                  </p>
                  <p className="font-mono break-all text-[11px] bg-slate-50 border border-slate-200 rounded px-2 py-1">
                    {enroll.secret}
                  </p>
                  <p className="mt-2">Issuer: {enroll.issuer}</p>
                  <p>Account: {enroll.label}</p>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Authenticator code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg tracking-[0.5em] text-center font-mono"
                    placeholder="000000"
                  />
                </div>
                <button
                  disabled={busy || code.length !== 6}
                  onClick={activate}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-60"
                >
                  Verify & enable
                </button>
              </div>
              <button
                onClick={() => {
                  setEnroll(null);
                  setCode("");
                  setQrDataUri(null);
                }}
                className="mt-3 text-xs text-slate-500 hover:text-slate-700"
              >
                Cancel enrollment
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldOff className="w-5 h-5 text-slate-500" />
                <h2 className="text-sm font-semibold text-slate-900">
                  MFA is off
                </h2>
              </div>
              <p className="text-sm text-slate-600 mb-4">
                Once enabled, sign-ins to this account will require a 6-digit
                code from your authenticator app.
              </p>
              <button
                onClick={startEnroll}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-red-600 to-orange-600 text-white text-sm font-semibold shadow disabled:opacity-60"
              >
                <ShieldCheck className="w-4 h-4" /> Enable MFA
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
