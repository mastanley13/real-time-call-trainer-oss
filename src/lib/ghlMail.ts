import "server-only";
import { GHL_TIMEOUT_MS } from "./ghlWebhook";
import { RESET_TTL_MINUTES } from "./passwordReset-types";

/**
 * Transactional email through the Calltrainer Tech GoHighLevel sub-account (API v2). Two calls, one attempt each, each
 * with the hard GHL_TIMEOUT_MS timeout used by the lifecycle emitter (ghlWebhook.ts):
 *   1. POST /contacts/upsert           { locationId, email (lowercased), tags: GHL_MAIL_TAGS }  -> contact.id
 *   2. POST /conversations/messages    { type: "Email", contactId, emailFrom, subject, html, message }
 * No names or phone numbers are sent. A failed or timed-out upsert means no send.
 *
 * Configured only when all three are set: GHL_API_TOKEN (Private Integration token for the location, scopes
 * contacts.write and conversations/message.write), GHL_LOCATION_ID and GHL_RESET_FROM_EMAIL (an address on a verified
 * sending domain of that location). Otherwise, outside production the message is printed to the console so local flows
 * can be tested; in production (whatever DEMO_MODE says) one generic warning is logged and nothing else, because the
 * body carries a bearer link.
 *
 * Never throws. Never logs the link, token, recipient, contact id, the GHL token or a GHL response body: failures log a
 * step name and, when there is one, the HTTP status.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text body, sent as `message`. */
  text: string;
  html: string;
}

export type MailResult = { ok: true } | { ok: false; reason: "not_configured" | "failed" };

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
export const GHL_UPSERT_URL = `${GHL_API_BASE}/contacts/upsert`;
export const GHL_MESSAGES_URL = `${GHL_API_BASE}/conversations/messages`;
/** Tags put on the contact by the upsert, so transactional contacts are told apart in a shared location. */
export const GHL_MAIL_TAGS = ["ct-transactional", "app-calltrainer"] as const;

type Env = Record<string, string | undefined>;

interface GhlMailConfig {
  token: string;
  locationId: string;
  from: string;
}

function ghlMailConfig(env: Env): GhlMailConfig | null {
  const token = env.GHL_API_TOKEN?.trim();
  const locationId = env.GHL_LOCATION_ID?.trim();
  const from = env.GHL_RESET_FROM_EMAIL?.trim();
  return token && locationId && from ? { token, locationId, from } : null;
}

export const ghlMailConfigured = (env: Env = process.env): boolean => ghlMailConfig(env) !== null;

type Step = "upsert" | "send";

class StepError extends Error {
  constructor(readonly step: Step, readonly status?: number) {
    super(step);
  }
}

async function post(step: Step, url: string, token: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
    });
  } catch {
    throw new StepError(step);
  }
  if (!res.ok) {
    // The body is never read: it can echo the recipient or the contact.
    await res.body?.cancel().catch(() => undefined);
    throw new StepError(step, res.status);
  }
  return res;
}

async function upsertContactId(cfg: GhlMailConfig, email: string): Promise<string> {
  const res = await post("upsert", GHL_UPSERT_URL, cfg.token, {
    locationId: cfg.locationId,
    email: email.trim().toLowerCase(),
    tags: [...GHL_MAIL_TAGS],
  });
  let id: unknown;
  try {
    const data = (await res.json()) as { contact?: { id?: unknown } } | null;
    id = data?.contact?.id;
  } catch {
    throw new StepError("upsert", res.status);
  }
  if (typeof id !== "string" || id.length === 0) throw new StepError("upsert", res.status);
  return id;
}

export async function sendMail(msg: MailMessage, env: Env = process.env): Promise<MailResult> {
  try {
    const cfg = ghlMailConfig(env);
    if (!cfg) {
      if (env.NODE_ENV !== "production") {
        console.info(`[mailer] Email is not configured, so this message was logged instead of sent.\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}`);
      } else {
        console.warn("[mailer] Email is not configured (set GHL_API_TOKEN, GHL_LOCATION_ID and GHL_RESET_FROM_EMAIL). A message was not sent.");
      }
      return { ok: false, reason: "not_configured" };
    }

    const contactId = await upsertContactId(cfg, msg.to);
    await post("send", GHL_MESSAGES_URL, cfg.token, {
      type: "Email",
      contactId,
      emailFrom: cfg.from,
      subject: msg.subject,
      html: msg.html,
      message: msg.text,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof StepError) {
      console.error(`[mailer] GHL ${e.step} failed${e.status ? ` with status ${e.status}` : ": the request did not complete"}.`);
    } else {
      console.error("[mailer] Send failed.");
    }
    return { ok: false, reason: "failed" };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export const RESET_EMAIL_SUBJECT = "Reset your Call Trainer password";

/** The reset email: one link, the expiry and the ignore line. Transactional only, no marketing content. */
export function passwordResetEmail(to: string, link: string): MailMessage {
  return {
    to,
    subject: RESET_EMAIL_SUBJECT,
    text: [
      "Use this link to choose a new Call Trainer password:",
      link,
      "",
      `The link expires in ${RESET_TTL_MINUTES} minutes.`,
      "",
      "If you did not ask for this, ignore this email.",
    ].join("\n"),
    html: [
      `<p><a href="${escapeHtml(link)}">Choose a new Call Trainer password</a></p>`,
      `<p>The link expires in ${RESET_TTL_MINUTES} minutes.</p>`,
      "<p>If you did not ask for this, ignore this email.</p>",
    ].join("\n"),
  };
}
