"use client";

import { FormEvent, useState } from "react";
import AuthShell from "@/components/AuthShell";

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
        // Full reload so the app boots with the new cookie. Only same-site paths are honoured.
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
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
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
      </form>
    </AuthShell>
  );
}
