/**
 * Pure helpers for the Models settings page: which model runs each job, and
 * which voice engines this server offers. Capabilities come from /api/config
 * and may gain fields from other features (realtime, voiceEngines), so every
 * read here is defensive and tolerates missing or oddly shaped values.
 */

export type JobId = "coach" | "grading" | "wizard" | "caller";

export interface JobRow {
  id: JobId;
  name: string;
  detail: string;
  /** True when this job runs on the configured model right now. */
  ai: boolean;
  /** What runs this job right now: the model id, or the fallback's name. */
  engine: string;
  fallbackName: string;
  fallback: string;
}

const JOBS: Omit<JobRow, "ai" | "engine">[] = [
  { id: "coach", name: "Live coach", detail: "Reads each of your turns during the call and suggests the next move.", fallbackName: "Rules-based coach", fallback: "Cues come from keyword triggers, the talk track and the persona's known objections." },
  { id: "grading", name: "Post-call grading", detail: "Scores the full transcript against the rubric and quotes your lines as evidence.", fallbackName: "Rules-based grader", fallback: "Scores how many rubric topics you covered and quotes your own lines. The debrief marks it as an estimate." },
  { id: "wizard", name: "Persona wizard", detail: "Drafts a new practice persona from your description or a web page.", fallbackName: "Template wizard", fallback: "Builds the persona from your answers with fixed templates, so you can still edit and save it." },
  { id: "caller", name: "Text caller", detail: "Plays the persona when you practise by typing instead of talking.", fallbackName: "Scripted caller", fallback: "Answers from the persona's sample lines, matched to what you say." },
];

type CapsLike = Record<string, unknown> | null | undefined;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function jobRows(caps: CapsLike): JobRow[] {
  const ai = caps?.llm === true;
  const model = str(caps?.model) ?? "AI model";
  return JOBS.map((j) => ({ ...j, ai, engine: ai ? model : j.fallbackName }));
}

export interface VoiceEngineRow {
  id: string;
  label: string;
  /** Model id when the engine reports one (the realtime model). */
  model?: string;
  available: boolean;
  /** The engine a new voice call uses first. */
  preferred: boolean;
  /** What to do when it isn't available. */
  setup: string;
}

const KNOWN = ["realtime", "elevenlabs"] as const;
const VOICE_LABELS: Record<string, string> = { realtime: "OpenAI Realtime", elevenlabs: "ElevenLabs voice agent" };
const VOICE_SETUP: Record<string, string> = {
  realtime: "Set OPENAI_API_KEY (or OPENAI_REALTIME_API_KEY) on the server.",
  elevenlabs: "Add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to the server environment.",
};
/** "openai", "openai-realtime" and "realtime" all name the same engine. */
const canonical = (id: string) => (/realtime|^openai$/i.test(id) ? "realtime" : id.toLowerCase());

function availability(o: Record<string, unknown>): boolean {
  for (const k of ["available", "configured", "enabled", "ready"]) if (typeof o[k] === "boolean") return o[k] as boolean;
  return true;
}

type Entry = { id: string; available: boolean; label?: string; model?: string };

/** Entries from `voiceEngines`: an ordered array of ids or objects (listed means available), or a map of id to flag. */
function listedEngines(listed: unknown): Entry[] {
  const out: Entry[] = [];
  const add = (id: string | undefined, available: boolean, o: Record<string, unknown> = {}) => {
    if (id) out.push({ id: canonical(id), available, label: str(o.label), model: str(o.model) });
  };
  if (Array.isArray(listed)) {
    for (const e of listed) {
      if (typeof e === "string") add(str(e), true);
      else if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        add(str(o.id) ?? str(o.engine) ?? str(o.name), availability(o), o);
      }
    }
  } else if (listed && typeof listed === "object") {
    for (const [id, v] of Object.entries(listed as Record<string, unknown>)) {
      if (typeof v === "boolean") add(id, v);
      else if (v && typeof v === "object") add(id, availability(v as Record<string, unknown>), v as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Every voice engine this app knows, plus any others the server lists, in the
 * server's preference order (available first). Availability comes from
 * `voiceEngines` when present, else from the `realtime` and `elevenlabs` flags.
 */
export function voiceEngines(caps: CapsLike): VoiceEngineRow[] {
  const rt = caps?.realtime;
  const rtObj = rt && typeof rt === "object" ? (rt as Record<string, unknown>) : {};
  const flags: Record<string, boolean> = {
    realtime: typeof rt === "boolean" ? rt : typeof rt === "string" ? !!str(rt) : rt && typeof rt === "object" ? availability(rtObj) : false,
    elevenlabs: caps?.elevenlabs === true,
  };
  const realtimeModel = (typeof rt === "string" ? str(rt) : str(rtObj.model)) ?? str(caps?.realtimeModel);
  const listed = listedEngines(caps?.voiceEngines);
  // A usable list is the source of truth (listed means available); otherwise fall back to the flags.
  const hasList = listed.length > 0;

  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const e of [...listed, ...KNOWN.map((id) => ({ id, available: hasList ? false : flags[id] }))]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    entries.push(e);
  }
  // Available engines first, keeping the server's order within each group.
  entries.sort((a, b) => Number(b.available) - Number(a.available));
  const firstAvailable = entries.find((e) => e.available)?.id;
  return entries.map((e) => ({
    id: e.id,
    label: e.label ?? VOICE_LABELS[e.id] ?? e.id,
    model: e.model ?? (e.id === "realtime" ? realtimeModel : undefined),
    available: e.available,
    preferred: e.id === firstAvailable,
    setup: VOICE_SETUP[e.id] ?? "Not set up on this server.",
  }));
}
