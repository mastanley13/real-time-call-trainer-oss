"use client";

/**
 * "Continue with Google". A plain link to the server route, which redirects to
 * Google; nothing about the flow runs in the browser. Shown only when the
 * server has Google sign-in set up.
 */
export default function GoogleButton({ next, code, manager, label = "Continue with Google" }: { next?: string; code?: string; manager?: string; label?: string }) {
  const params = new URLSearchParams();
  if (next) params.set("next", next);
  if (code) params.set("code", code);
  if (code && manager) params.set("manager", manager);
  const qs = params.toString();
  return (
    <a href={`/api/auth/google/start${qs ? `?${qs}` : ""}`} className="btn-ghost w-full justify-center">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <path fill="rgb(var(--ink))" d="M21.6 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.32 2.98-7.35Z" />
        <path fill="rgb(var(--ink-soft))" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.04.95-3.38.95-2.6 0-4.8-1.75-5.59-4.1H3.07v2.58A10 10 0 0 0 12 22Z" />
        <path fill="rgb(var(--ink-muted))" d="M6.41 13.93a6 6 0 0 1 0-3.86V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.58Z" />
        <path fill="rgb(var(--primary))" d="M12 5.97c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.58C7.2 7.72 9.4 5.97 12 5.97Z" />
      </svg>
      {label}
    </a>
  );
}

/** Divider between the Google button and the email form. */
export function OrDivider() {
  return (
    <div className="my-4 flex items-center gap-3 text-xs text-ink-muted" aria-hidden>
      <span className="h-px flex-1 bg-line" /> or use email <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Human messages for the ?error= codes the Google callback sends back to /login. */
export const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: "Google sign-in was cancelled. Try again, or use your email and password.",
  google_expired: "That Google sign-in took too long or was opened in another tab. Try again.",
  google_failed: "Google sign-in didn't work. Try again, or use your email and password.",
  google_unverified: "Your Google account's email isn't verified. Verify it with Google, or sign up with email.",
  google_not_configured: "Google sign-in isn't set up on this server. Use your email and password.",
  locked: "This account is temporarily locked after too many attempts. Try again in 15 minutes.",
};
