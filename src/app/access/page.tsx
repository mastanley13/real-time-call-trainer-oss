"use client";

import { FormEvent, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { safeNextPath } from "@/lib/access";

export default function AccessPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        // Full reload so the app boots with the new cookie. safeNextPath keeps same-origin targets only.
        const target = safeNextPath(new URLSearchParams(window.location.search).get("next"), window.location.origin);
        window.location.assign(target);
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.message || data.error || "Something went wrong. Try again.");
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setBusy(false);
  }

  return (
    <AuthShell title="Enter access code" subtitle="This trainer is invite-only. Enter the code you were given.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="access-code" className="label">Access code</label>
          <input id="access-code" type="password" className="input" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        </div>
        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
      </form>
    </AuthShell>
  );
}
