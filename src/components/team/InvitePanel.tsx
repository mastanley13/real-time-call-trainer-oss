"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Builds the sign-up link a rep opens to join this team. Digits only, so nothing else can ride in the query. */
export function inviteLink(origin: string, code: string): string | null {
  if (!/^[0-9]{3,8}$/.test(code)) return null;
  return `${origin.replace(/\/+$/, "")}/register?code=${code}`;
}

/**
 * How a manager adds people: the team code and a sign-up link that fills it in. Reads the code from /api/me,
 * which every member already gets. Renders nothing until the code is known.
 */
export default function InvitePanel() {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { organization?: { code?: unknown } | null } | null) => {
        const c = body?.organization?.code;
        if (live && typeof c === "string") setCode(c);
      })
      .catch(() => { /* the panel just stays hidden */ });
    return () => { live = false; };
  }, []);

  const link = code && typeof window !== "undefined" ? inviteLink(window.location.origin, code) : null;
  if (!code || !link) return null;

  async function copy(what: "link" | "code", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard blocked: the text is on screen to copy by hand */ }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="invite-h">
      <h2 id="invite-h" className="text-sm font-bold">Add people to your team</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Send this link. They sign up with their email and a password, and land on your team. Google sign-up starts a separate team, so they should use email.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 max-w-full break-all rounded-lg bg-sunken px-3 py-2 font-mono text-xs">{link}</code>
        <button type="button" className="btn-ghost" onClick={() => copy("link", link)}>
          {copied === "link" ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        Team code: <span className="font-mono font-semibold text-ink">{code}</span>{" "}
        <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => copy("code", code)}>
          {copied === "code" ? "Copied" : "Copy"}
        </button>
      </p>
    </section>
  );
}
