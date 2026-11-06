/**
 * Copy and small pure helpers for the live call screen ("Buyer and brief"). Client-safe: no secrets, no provider calls,
 * and no example copy. The screen only shows what the running call reports.
 */

/** The heading over the conversation. The persona's name stays the page's h1. */
export const CALL_HEADLINE = "Stay with the buyer.";

/**
 * Plain status words for the call header. Only states the call controllers actually report (RealtimeVoiceSession, the
 * voice session in TrainerClient, and the text call). There is no reconnecting or continue-in-text state to show.
 */
export const CALL_STATUS = {
  listening: "Listening",
  muted: "Muted",
  connecting: "Connecting",
  allowMic: "Allow the microphone",
  connectingAllowMic: "Connecting. Allow the microphone if asked.",
  wrappingUp: "Wrapping up",
  ended: "Call ended",
  grading: "Grading",
  yourTurn: "Your turn",
} as const;

export const speakingStatus = (name: string) => `${name} is speaking`;
export const typingStatus = (name: string) => `${name} is typing`;
export const hungUpStatus = (name: string) => `${name} hung up`;

/** Under every live cue: a cue is coaching, never a score. */
export const CUE_NOTE = "Live coaching, not a final grade. Only you see it.";

/** Shown instead of an error that names a vendor, a model or a server setting. The transcript is never lost. */
export const CALL_TROUBLE_MESSAGE = "The call hit a problem. Your transcript so far is kept.";

const VENDOR_RE = /\b(?:open\s?ai|eleven\s?labs|anthropic|gemini|gpt-[\w.-]*|whisper-\d|tts-\d)\b/i;
/** Server setting names such as an env variable (UPPER_SNAKE_CASE). */
const ENV_RE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

/** True when text names a vendor, a model or a server setting. */
export const namesVendorOrEnv = (text: string): boolean => VENDOR_RE.test(text) || ENV_RE.test(text);

/**
 * The error line on the call screen. A voice SDK or a server message can name the provider or a setting; the rep gets
 * a plain sentence instead. Everything else (cap messages included) passes through unchanged, so CallError still
 * recognises them.
 */
export function callErrorText(message: string): string {
  return namesVendorOrEnv(message) ? CALL_TROUBLE_MESSAGE : message;
}

/**
 * The one cue the rail shows: the newest cue, while it is still active. Older cues never resurface when the newest is
 * used or hidden; they stay in the coach log and in Earlier cues.
 */
export function nextMoveCue<T extends { status: string }>(cues: readonly T[]): T | undefined {
  const newest = cues[0];
  return newest?.status === "active" ? newest : undefined;
}
