"use client";

import { FormEvent, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AuthShell, { PasswordInput } from "@/components/AuthShell";
import LegalLinks from "@/components/LegalLinks";

export default function AccessPage() {
  const [code, setCode] = useState("");
  // A rejected code is about the field; a failed request is about the form.
  const [codeError, setCodeError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState(false);

  useEffect(() => {
    setInvited(new URLSearchParams(window.location.search).get("reason") === "google_invite");
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The button stays focusable while busy (aria-disabled), so a second Enter lands here and stops.
    if (busy) return;
    setCodeError("");
    setFormError("");
    setBusy(true);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        // Full reload so the app boots with the new cookie. Resolve ?next= and compare origins,
        // because the URL parser reads "/\evil.com" and "/\t/evil.com" as protocol-relative.
        const next = new URLSearchParams(window.location.search).get("next");
        let target = "/";
        try {
          const u = next ? new URL(next, window.location.origin) : null;
          if (u && u.origin === window.location.origin) target = u.pathname + u.search + u.hash;
        } catch {
          // Unparseable value: fall back to home.
        }
        window.location.assign(target);
        return;
      }
      const data = await res.json().catch(() => ({}));
      const msg = data.message || data.error || "Something went wrong. Try again.";
      if (res.status === 400 || res.status === 401 || res.status === 403) setCodeError(msg);
      else setFormError(msg);
    } catch {
      setFormError("Could not reach the server. Try again.");
    }
    setBusy(false);
  }

  return (
    <AuthShell title="Enter access code" subtitle="Enter your access code to continue.">
      {invited && (
        <div className="banner-warn mb-4">New accounts need the access code. Enter it, then choose Continue with Google again.</div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="access-code" className="label">Access code</label>
          <PasswordInput
            id="access-code"
            toggleLabel="Show access code"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? "access-code-error" : undefined}
            required
            autoFocus
          />
          {codeError && <p id="access-code-error" role="alert" className="field-msg">{codeError}</p>}
        </div>
        {formError && <p role="alert" className="banner-alert">{formError}</p>}
        <button type="submit" className="btn-primary w-full" aria-disabled={busy || undefined}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      <LegalLinks />
    </AuthShell>
  );
}
