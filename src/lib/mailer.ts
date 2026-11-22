import "server-only";

/**
 * Outbound email. Sends through the Resend HTTP API when RESEND_API_KEY and MAIL_FROM are both set.
 * Without them it logs the message to the server console outside production so local flows can be tested. In
 * production it never logs the recipient or body, whatever DEMO_MODE says (the body can carry a bearer link): it logs
 * one generic warning instead. Never throws.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailResult = { ok: true } | { ok: false; reason: "not_configured" | "failed" };

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export function mailConfigured(env: Env = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim());
}

export async function sendMail(msg: MailMessage, env: Env = process.env): Promise<MailResult> {
  try {
    const apiKey = env.RESEND_API_KEY?.trim();
    const from = env.MAIL_FROM?.trim();
    if (!apiKey || !from) {
      if (env.NODE_ENV !== "production") {
        console.info(`[mailer] Email is not configured, so this message was logged instead of sent.\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}`);
      } else {
        console.warn("[mailer] Email is not configured (set RESEND_API_KEY and MAIL_FROM). A message was not sent.");
      }
      return { ok: false, reason: "not_configured" };
    }

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only: the provider's body can echo the recipient.
      console.error(`[mailer] Send failed with status ${res.status}.`);
      return { ok: false, reason: "failed" };
    }
    return { ok: true };
  } catch {
    console.error("[mailer] Send failed: the request did not complete.");
    return { ok: false, reason: "failed" };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
