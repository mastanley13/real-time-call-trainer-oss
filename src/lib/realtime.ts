/**
 * OpenAI Realtime voice engine: config, engine selection and transcript assembly.
 *
 * Isomorphic on purpose: the turn assembler and engine helpers run in the browser,
 * the env readers run on the server. Next only inlines NEXT_PUBLIC_* vars into client
 * bundles, so realtimeKey() evaluates to undefined there and never leaks a key.
 *
 * Docs this follows (checked 2026-10):
 * - Realtime guide: https://developers.openai.com/api/docs/guides/realtime
 * - WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
 *   POST /v1/realtime/client_secrets (server, API key) -> { value: "ek_...", expires_at, session };
 *   browser POSTs its SDP offer to /v1/realtime/calls with "Authorization: Bearer ek_..." and
 *   "Content-Type: application/sdp"; events flow over the "oai-events" data channel.
 * - Client secrets: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
 * - Server events: https://developers.openai.com/api/reference/resources/realtime/server-events
 * - Client events: https://developers.openai.com/api/reference/resources/realtime/client-events
 * - Reference app: https://github.com/openai/openai-realtime-agents (beta event names, kept as fallbacks)
 */

export type VoiceEngine = "openai" | "elevenlabs";

export const VOICE_ENGINE_LABELS: Record<VoiceEngine, string> = { openai: "OpenAI Realtime", elevenlabs: "ElevenLabs" };

/** Built-in output voices accepted by session.audio.output.voice. The docs recommend marin or cedar. */
export const REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];

/**
 * gpt-realtime-2.1-mini runs every standard call: about a third of the full model's audio token price.
 * Premium calls keep the full gpt-realtime-2.1 (REALTIME_MODEL_PREMIUM overrides it).
 */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_REALTIME_PREMIUM_MODEL = "gpt-realtime-2.1";
/** Which plan a voice call is billed to. Only "standard" is wired today; plans arrive with STR-689/STR-690. */
export type RealtimeTier = "standard" | "premium";
export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "marin";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

type Env = Record<string, string | undefined>;

const isOpenAiBase = (url: string | undefined) => /^https:\/\/api\.openai\.com\b/.test((url || "https://api.openai.com/v1").trim());

/** OPENAI_REALTIME_API_KEY, else OPENAI_API_KEY, else LLM_API_KEY only when LLM_BASE_URL points at OpenAI. */
export function resolveRealtimeKey(env: Env): string | undefined {
  const k = (v: string | undefined) => (v && v.trim()) || undefined;
  return k(env.OPENAI_REALTIME_API_KEY) || k(env.OPENAI_API_KEY) || (isOpenAiBase(env.LLM_BASE_URL) ? k(env.LLM_API_KEY) : undefined);
}

export const realtimeKey = (): string | undefined => resolveRealtimeKey(process.env);
export const realtimeModel = (tier: RealtimeTier = "standard"): string =>
  tier === "premium"
    ? process.env.REALTIME_MODEL_PREMIUM?.trim() || DEFAULT_REALTIME_PREMIUM_MODEL
    : process.env.REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
export const realtimeTranscribeModel = (): string => process.env.REALTIME_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;

export const isRealtimeVoice = (v: unknown): v is RealtimeVoice => typeof v === "string" && (REALTIME_VOICES as readonly string[]).includes(v);

/** Persona voice wins, then REALTIME_VOICE, then the default. Unknown names are ignored rather than sent upstream. */
export function pickRealtimeVoice(personaVoice: string | undefined, envVoice: string | undefined): RealtimeVoice {
  const env = envVoice?.trim().toLowerCase();
  const persona = personaVoice?.trim().toLowerCase();
  if (isRealtimeVoice(persona)) return persona;
  if (isRealtimeVoice(env)) return env;
  return DEFAULT_REALTIME_VOICE;
}

export const realtimeVoice = (personaVoice?: string): RealtimeVoice => pickRealtimeVoice(personaVoice, process.env.REALTIME_VOICE);

/** Available engines, OpenAI first unless VOICE_ENGINE=elevenlabs asks otherwise. */
export function orderVoiceEngines(available: { openai: boolean; elevenlabs: boolean }, preferred?: string): VoiceEngine[] {
  const out: VoiceEngine[] = [];
  if (available.openai) out.push("openai");
  if (available.elevenlabs) out.push("elevenlabs");
  if (preferred?.trim().toLowerCase() === "elevenlabs" && out.length === 2) out.reverse();
  return out;
}

/** The engine to use: the viewer's saved pick if the server still offers it, else the server's first choice. */
export function chooseVoiceEngine(engines: readonly VoiceEngine[] | undefined, saved?: string | null): VoiceEngine | null {
  if (!engines?.length) return null;
  return engines.find((e) => e === saved) ?? engines[0];
}

/** Instructions for the first response, so the persona opens with the scenario's exact line. */
export function openingInstructions(name: string, line: string): string {
  return `You are ${name} and the phone call just connected. Say exactly the following line, word for word, in your own natural voice, then stop and wait for the other person to reply. Do not add anything before or after it.\n\n"${line.trim()}"`;
}

/** Average of analyser frequency bins on a 0..1 scale (same measure ElevenLabs uses for its volume getters). */
export function averageLevel(bins: ArrayLike<number>): number {
  if (!bins.length) return 0;
  let sum = 0;
  for (let i = 0; i < bins.length; i++) sum += bins[i];
  return Math.min(1, Math.max(0, sum / bins.length / 255));
}

/** getUserMedia failure -> what happened and how to fix it. */
export function micErrorMessage(e: unknown): string {
  const name = typeof e === "object" && e && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow the mic for this site in your browser's address bar, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in, or switch to Text mode.";
  if (name === "NotReadableError" || name === "AbortError") return "Your microphone is busy in another app. Close that app, then try again.";
  return "Could not open your microphone. Check the browser's mic permission, then try again.";
}

/* ---------- Transcript assembly ---------- */

export interface AssembledTurn { role: "user" | "assistant"; text: string }

type ItemState = "pending" | "ready" | "done";
interface Item { id: string; role: AssembledTurn["role"]; text: string; state: ItemState; since: number }

/**
 * Orders realtime transcripts into turns. Transcripts arrive out of order: the trainee's
 * transcription often completes after the persona has already started (or finished) its reply.
 * Items are registered in conversation order (committed / added events, using previous_item_id),
 * then released in that order once their transcript is final. An item stuck pending longer than
 * maxWaitMs is skipped so one lost transcription cannot freeze the transcript; if it arrives
 * later it is released then rather than dropped.
 */
export class TurnAssembler {
  private items: Item[] = [];
  private byId = new Map<string, Item>();
  constructor(private maxWaitMs = 15_000) {}

  /** Register an item's place in the conversation. Safe to call more than once per item. */
  note(id: string, role: AssembledTurn["role"], previousId?: string | null, now = Date.now()): void {
    if (!id || this.byId.has(id)) return;
    const item: Item = { id, role, text: "", state: "pending", since: now };
    this.byId.set(id, item);
    const prev = previousId ? this.items.findIndex((i) => i.id === previousId) : -1;
    if (prev >= 0) this.items.splice(prev + 1, 0, item);
    else this.items.push(item);
  }

  /** A final transcript for an item. Unknown items are appended (the added event was missed). */
  finalize(id: string, role: AssembledTurn["role"], text: string, now = Date.now()): void {
    if (!this.byId.has(id)) this.note(id, role, null, now);
    const item = this.byId.get(id)!;
    if (item.state === "done") return;
    item.text = text.trim();
    item.state = "ready";
  }

  /** Transcription failed or the item had no speech: release it as empty (empty turns are never emitted). */
  fail(id: string): void {
    const item = this.byId.get(id);
    if (item && item.state === "pending") { item.text = ""; item.state = "ready"; }
  }

  /** Fallback from response.done: fill an item only if no transcript event already did. */
  settle(id: string, role: AssembledTurn["role"], text: string, now = Date.now()): void {
    const item = this.byId.get(id);
    if (item && item.state !== "pending") return;
    if (text.trim()) this.finalize(id, role, text, now);
    else if (item) this.fail(id);
  }

  get pending(): number { return this.items.filter((i) => i.state === "pending").length; }

  /** Turns now ready to show, in conversation order. force releases everything final and gives up on the rest. */
  flush(now = Date.now(), force = false): AssembledTurn[] {
    const out: AssembledTurn[] = [];
    let blocked = false;
    for (const item of this.items) {
      if (item.state === "done") continue;
      if (item.state === "ready") {
        if (blocked && !force) continue;
        item.state = "done";
        if (item.text) out.push({ role: item.role, text: item.text });
        continue;
      }
      // pending: hold everything after it, unless it has waited too long
      if (!force && now - item.since < this.maxWaitMs) blocked = true;
    }
    return out;
  }
}

/** Minimal shape of the server events we read from the data channel. */
export interface RealtimeServerEvent {
  type: string;
  item_id?: string;
  previous_item_id?: string | null;
  transcript?: string;
  item?: { id?: string; type?: string; role?: string };
  response?: { status?: string; output?: { id?: string; type?: string; role?: string; content?: { transcript?: string; text?: string }[] }[] };
  error?: { message?: string; code?: string; type?: string };
}

/**
 * Feeds one server event into the assembler. Returns true when transcript state changed.
 * GA names first; the beta names (response.audio_transcript.done, conversation.item.created)
 * are what openai-realtime-agents still listens for.
 */
export function applyRealtimeEvent(asm: TurnAssembler, ev: RealtimeServerEvent, now = Date.now()): boolean {
  switch (ev.type) {
    case "input_audio_buffer.committed":
      if (!ev.item_id) return false;
      asm.note(ev.item_id, "user", ev.previous_item_id, now);
      return true;
    case "conversation.item.added":
    case "conversation.item.created":
    case "response.output_item.added": {
      const it = ev.item;
      if (!it?.id || it.type !== "message" || (it.role !== "user" && it.role !== "assistant")) return false;
      asm.note(it.id, it.role, ev.previous_item_id, now);
      return true;
    }
    case "conversation.item.input_audio_transcription.completed":
      if (!ev.item_id) return false;
      asm.finalize(ev.item_id, "user", ev.transcript ?? "", now);
      return true;
    case "conversation.item.input_audio_transcription.failed":
      if (!ev.item_id) return false;
      asm.fail(ev.item_id);
      return true;
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      if (!ev.item_id) return false;
      asm.finalize(ev.item_id, "assistant", ev.transcript ?? "", now);
      return true;
    case "response.done": {
      // An interrupted or failed reply may never send a transcript done event; settle it here so it cannot block.
      let changed = false;
      for (const it of ev.response?.output ?? []) {
        if (!it.id || it.type !== "message" || it.role !== "assistant") continue;
        asm.settle(it.id, "assistant", (it.content ?? []).map((c) => c.transcript ?? c.text ?? "").join(" "), now);
        changed = true;
      }
      return changed;
    }
    default:
      return false;
  }
}

/** Upstream status from client_secrets -> a message an operator can act on. Never includes the upstream body. */
export function realtimeUpstreamMessage(status: number, model: string): string {
  if (status === 401) return "OpenAI rejected the API key. Check OPENAI_API_KEY.";
  if (status === 403) return "This OpenAI key cannot use the Realtime API. Check the project's model access in the OpenAI dashboard.";
  if (status === 404 || status === 400) return `OpenAI did not accept the voice session settings. Check that REALTIME_MODEL (${model}) and REALTIME_VOICE are valid.`;
  if (status === 429) return "OpenAI rate-limited this key or it is out of quota. Check your plan and billing, then try again.";
  return "OpenAI's Realtime API had a problem starting the call. Try again in a minute, or switch to Text.";
}
