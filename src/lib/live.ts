/**
 * OpenAI GPT-Live voice engine: switch, voices, prompt and transcript assembly.
 *
 * GPT-Live is a separate API from Realtime (POST /v1/live/sessions, not /v1/realtime). It is full duplex: the persona
 * keeps listening while it talks, so a caller can talk over the trainee and the trainee can cut in. It bills a flat
 * rate per active minute instead of audio tokens.
 *
 * It is OFF unless the server sets OPENAI_VOICE_API=live. With the switch off nothing here runs and every call uses
 * the Realtime path exactly as before. Set it on a preview deployment first to test.
 *
 * Isomorphic on purpose, like realtime.ts: the transcript assembler runs in the browser, the env readers on the server.
 *
 * Docs this follows (checked 2026-11-20):
 * - Models: https://developers.openai.com/api/docs/models (the GPT-Live entries)
 * - Getting started: https://developers.openai.com/api/docs/guides/live
 * - WebRTC: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
 *   The server posts { session, transport: { type: "webrtc", sdp } } to /v1/live/sessions with the project API key and
 *   gets back { session: { id }, transport: { sdp } }. There is no ephemeral client secret. Events flow over the
 *   "oai-events" data channel; wait for session.started; never send session.start over WebRTC.
 * - Sessions, voices, transcripts, close: https://developers.openai.com/api/docs/guides/live-conversations
 * - Prompting: https://developers.openai.com/api/docs/guides/live-prompting
 * - Migration from Realtime: https://developers.openai.com/api/docs/guides/live-migration
 */

import { buildAgentPrompt, type Scenario } from "./scenarios";
import { liveCastingSection } from "./liveCasting";

export type OpenAiVoiceApi = "realtime" | "live";

type Env = Record<string, string | undefined>;

/** "live" only when OPENAI_VOICE_API is exactly live (any case). Anything else, or unset, keeps Realtime. */
export const openAiVoiceApi = (env: Env = process.env): OpenAiVoiceApi =>
  env.OPENAI_VOICE_API?.trim().toLowerCase() === "live" ? "live" : "realtime";

/* The Live model id (LIVE_MODEL) is resolved in src/lib/voiceModels.ts, on the server only. */

/**
 * Voices a Live session accepts in audio.output.voice. marin is the documented default and is used in OpenAI's own
 * Live recipes; cedar is the other recommended Realtime voice. The rest are the Live-only voices from the voice
 * options table. Realtime-only names (alloy, ash, ...) are not listed for Live, so they fall back rather than risk a
 * rejected session.
 */
export const LIVE_VOICES = [
  "marin", "cedar",
  "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "beacon", "delta", "cinder",
  "bossa", "tempo", "nuri", "juni", "flitz", "brise", "sillage", "nira", "harema", "shida", "noeul",
] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];
export const DEFAULT_LIVE_VOICE: LiveVoice = "marin";

export const isLiveVoice = (v: unknown): v is LiveVoice => typeof v === "string" && (LIVE_VOICES as readonly string[]).includes(v);

/**
 * Persona's liveVoice, then its realtimeVoice when Live has it too, then LIVE_VOICE, then marin. Unknown names are
 * ignored rather than sent upstream.
 */
export function pickLiveVoice(persona: { liveVoice?: string; realtimeVoice?: string }, envVoice?: string): LiveVoice {
  for (const v of [persona.liveVoice, persona.realtimeVoice, envVoice]) {
    const n = v?.trim().toLowerCase();
    if (isLiveVoice(n)) return n;
  }
  return DEFAULT_LIVE_VOICE;
}

/**
 * Persona prompt for GPT-Live. The persona text is the same one Realtime, ElevenLabs and the text caller get
 * (buildAgentPrompt). OpenAI's Live prompting guide asks for three named sections, kept verbatim as headings:
 * Backchannel policy, Interruption policy and Delegation policy. A caller in a practice call has no backend tools,
 * so it never delegates (with no delegation configured the session is in client mode and nothing would answer).
 * Persona-specific overrides come from aiPersona.liveBackchannel and aiPersona.liveInterruption when set.
 */
export function buildLiveInstructions(s: Scenario): string {
  const p = s.aiPersona;
  const casting = liveCastingSection(p);
  const backchannel = p.liveBackchannel?.trim()
    || "Use occasional short, natural listening sounds such as \"mm-hm\", \"yeah\" or \"okay\" while the other person explains something, the way a real caller on the phone would. Keep them brief and never let them compete with what the other person is saying.";
  const interruption = p.liveInterruption?.trim()
    || "When the other person interrupts you, stop speaking and listen, unless your character is upset enough that a real person would keep talking for a moment. If they ask you to stop or wait, or ask a direct question, stop right away and answer it. Respond to their latest question; do not resume a point they have moved past.";
  return [
    buildAgentPrompt(s),
    "",
    "VOICE AND DELIVERY",
    "- You are a person on a phone call, not an assistant. Speak casually with contractions, natural hesitations and the emotion your situation calls for. Perform feelings in your voice; never say stage directions out loud.",
    "- Keep each turn short and leave the trainee room to lead the call.",
    "- Keep listening while the trainee pauses to think. Do not treat a cough, typing or background noise as a new question.",
    "- If the trainee asks you to repeat or spell a name, address, number or code, say it again clearly and slowly.",
    // Age, maturity, emotional tone and delivery notes: the Live API has no field for them, so they go in the instructions.
    ...(casting.length ? ["", ...casting] : []),
    "",
    `Backchannel policy: ${backchannel}`,
    "",
    `Interruption policy: ${interruption}`,
    "",
    "Delegation policy: There is no backend and you have no tools. Do not delegate to the backend, ever. Answer everything yourself, in character, from what you know as this person.",
  ].join("\n");
}

/**
 * Developer message for session.input so the persona speaks first. The Live guide's "Greet before the caller speaks"
 * recipe: put the greeting in a developer message at startup, say it, then pause and listen. Startup instructions
 * improve but do not guarantee that the model speaks first, so a silent start is a known risk to test.
 */
export function liveOpeningMessage(line: string): string {
  return `The phone call just connected. Speak first, now, in English. Say exactly this line, word for word, with no introduction: "${line.trim()}" Then stop and listen.`;
}

/** Body for POST /v1/live/sessions over WebRTC. WebRTC negotiates the audio format, so audio.format is left out. */
export function liveSessionBody(args: { model: string; voice: LiveVoice; instructions: string; openingLine?: string; sdp: string }) {
  const line = args.openingLine?.trim();
  return {
    session: {
      model: args.model,
      instructions: args.instructions,
      ...(line ? { input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: liveOpeningMessage(line) }] }] } : {}),
      audio: { output: { voice: args.voice } },
    },
    transport: { type: "webrtc", sdp: args.sdp },
  };
}

/** Upstream status from /v1/live/sessions -> a message an operator can act on. Never names the model or echoes the body. */
export function liveUpstreamMessage(status: number): string {
  if (status === 401) return "OpenAI rejected the API key. Check OPENAI_API_KEY and any OPENAI_API_KEY_BACKUP_* keys.";
  if (status === 403) return "This OpenAI key cannot use the live voice API. Check the project's model access in the OpenAI dashboard, or unset OPENAI_VOICE_API.";
  if (status === 404 || status === 400 || status === 422) return "OpenAI did not accept the live voice session settings. Check LIVE_MODEL and LIVE_VOICE, or unset OPENAI_VOICE_API to use Realtime.";
  if (status === 429) return "OpenAI rate-limited this key, it is out of quota, or the live voice concurrent session limit is reached. Try again shortly.";
  return "OpenAI's live voice API had a problem starting the call. Try again in a minute, or switch to Text.";
}

/* ---------- Transcript assembly ---------- */

export interface LiveTurn { role: "user" | "assistant"; text: string }

interface Segment { role: LiveTurn["role"]; text: string; start: number; end: number; lastArrival: number; closed: boolean }

/**
 * Builds turns from GPT-Live transcript deltas. Live has no item ids and no end-of-turn event: each delta carries a
 * text fragment and its start_ms/end_ms on the session timeline. Both speakers can talk at once, so each speaker
 * keeps its own open segment. A delta joins its speaker's open segment when it starts within gapMs of that segment's
 * end; otherwise the segment closes and a new one opens. A segment also closes when no delta for it has arrived for
 * idleMs of wall-clock time.
 *
 * Closed segments are released in start order, and only once no still-open segment started earlier, so a short
 * "mm-hm" from the persona never jumps ahead of the trainee sentence it overlapped.
 */
export class LiveTranscript {
  private segs: Segment[] = [];
  private open: Partial<Record<LiveTurn["role"], Segment>> = {};
  constructor(private gapMs = 1200, private idleMs = 2000) {}

  add(role: LiveTurn["role"], delta: string, startMs?: number, endMs?: number, now = Date.now()): void {
    if (!delta) return;
    const cur = this.open[role];
    const start = typeof startMs === "number" && Number.isFinite(startMs) ? startMs : (cur?.end ?? 0);
    const end = typeof endMs === "number" && Number.isFinite(endMs) ? Math.max(endMs, start) : start;
    if (cur && start - cur.end <= this.gapMs) {
      cur.text += delta;
      cur.end = Math.max(cur.end, end);
      cur.lastArrival = now;
      return;
    }
    if (cur) cur.closed = true;
    const seg: Segment = { role, text: delta, start, end, lastArrival: now, closed: false };
    this.open[role] = seg;
    this.segs.push(seg);
  }

  /** Text fragments not yet released. Used to wait briefly for the last words on hang-up. */
  get pending(): number { return this.segs.length; }

  /** Turns ready to show, in timeline order. force closes everything (hang-up or failure). */
  flush(now = Date.now(), force = false): LiveTurn[] {
    for (const s of this.segs) if (!s.closed && (force || now - s.lastArrival >= this.idleMs)) s.closed = true;
    for (const r of ["user", "assistant"] as const) if (this.open[r]?.closed) delete this.open[r];
    const ordered = [...this.segs].sort((a, b) => a.start - b.start);
    const out: LiveTurn[] = [];
    const released = new Set<Segment>();
    for (const s of ordered) {
      if (!s.closed) break;
      released.add(s);
      const text = s.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      // Two releases in a row from the same speaker read as one turn.
      const last = out[out.length - 1];
      if (last && last.role === s.role) last.text = `${last.text} ${text}`;
      else out.push({ role: s.role, text });
    }
    this.segs = this.segs.filter((s) => !released.has(s));
    return out;
  }
}

/** Minimal shape of the GPT-Live server events read from the data channel. */
export interface LiveServerEvent {
  type: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  reason?: string;
  usage?: { seconds?: number };
  error?: { message?: string; code?: string | null; type?: string };
}

/** Feeds one server event into the transcript. Returns true when transcript state changed. */
export function applyLiveEvent(t: LiveTranscript, ev: LiveServerEvent, now = Date.now()): boolean {
  if (typeof ev.delta !== "string") return false;
  if (ev.type === "session.input_transcript.delta") { t.add("user", ev.delta, ev.start_ms, ev.end_ms, now); return true; }
  if (ev.type === "session.output_transcript.delta") { t.add("assistant", ev.delta, ev.start_ms, ev.end_ms, now); return true; }
  return false;
}
