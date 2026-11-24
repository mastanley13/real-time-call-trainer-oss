/**
 * GPT-Live casting: which official Live voice plays a persona, and the delivery notes that go into the session
 * instructions. Pure and client-safe. Only used on the GPT-Live path (OPENAI_VOICE_API=live, off by default); the
 * Realtime path never reads these fields.
 *
 * Only the voices OpenAI documents for GPT-Live are cast here. The API has no age, accent or style field: the voice is
 * chosen once at startup (session.audio.output.voice), and age, maturity, pace, expressiveness and emotional tone are
 * asked for in plain words in session.instructions. A voice's age is not guaranteed, so the instructions say how old the
 * person is (or that it is unspecified) and how they sound. Whether a cast sounds right has to be judged by listening.
 *
 * Casting is data on the persona (aiPersona.liveVoice, aiPersona.liveDelivery), authored per persona in
 * src/lib/personaLiveCasting.ts, never a switch on a persona's name.
 */

export const LIVE_CAST_VOICES = ["gleam", "meridian", "delta", "cinder", "quartz", "ripple", "vesper", "willow", "stone", "marin", "cedar"] as const;
export type LiveCastVoice = (typeof LIVE_CAST_VOICES)[number];

export interface LiveVoiceProfile {
  /** "neutral" is the default voice, used when a persona's gender is not stated. */
  gender: "female" | "male" | "neutral";
  accent: string;
}

/** What OpenAI's GPT-Live voice list says about each cast voice. cedar is only kept for personas that already used it. */
export const LIVE_VOICE_PROFILES: Record<LiveCastVoice, LiveVoiceProfile> = {
  gleam: { gender: "female", accent: "North American" },
  meridian: { gender: "male", accent: "North American" },
  delta: { gender: "female", accent: "Southern US" },
  cinder: { gender: "male", accent: "Southern US" },
  quartz: { gender: "female", accent: "Australian" },
  ripple: { gender: "male", accent: "Australian" },
  vesper: { gender: "male", accent: "British" },
  willow: { gender: "female", accent: "Irish" },
  stone: { gender: "male", accent: "Irish" },
  marin: { gender: "neutral", accent: "default" },
  cedar: { gender: "male", accent: "unspecified" },
};

export const isLiveCastVoice = (v: unknown): v is LiveCastVoice => typeof v === "string" && (LIVE_CAST_VOICES as readonly string[]).includes(v);

/**
 * True when the official voice suits the stated gender. A stated woman takes a feminine voice or marin (the default
 * voice, which this library also uses for older, warmer or more senior women); a stated man takes a masculine voice
 * (cedar included). With no gender stated only marin is cast: a gendered voice would announce a gender nobody stated.
 */
export function liveCastFits(voice: string | undefined, gender: "female" | "male" | undefined): boolean {
  const v = voice?.trim().toLowerCase();
  if (!isLiveCastVoice(v)) return false;
  const g = LIVE_VOICE_PROFILES[v].gender;
  if (!gender) return g === "neutral";
  return g === gender || (gender === "female" && g === "neutral");
}

/** What a persona states about itself, plus its Live cast. Anything not stated stays undefined. */
export interface LiveCastPersona {
  /** Only when the persona's own text states it. */
  gender?: "female" | "male";
  age?: number;
  /** A casting age band such as "teen (17 to 19)", for a persona with no exact age. */
  ageBand?: string;
  emotion?: string;
  liveVoice?: string;
  liveDelivery?: string;
}

/** A plain-word maturity band for a stated age. */
export function maturityOf(age: number | undefined): string | null {
  if (age === undefined) return null;
  if (age <= 12) return "a young child";
  if (age < 18) return "a teenager";
  if (age < 30) return "a young adult";
  if (age < 60) return "an adult";
  if (age < 80) return "an older adult";
  return "elderly";
}

const article = (age: number) => (age === 8 || age === 11 || age === 18 || (age >= 80 && age <= 89) ? "an" : "a");
const noun = (g: "female" | "male", age: number | undefined) => (g === "female" ? (age !== undefined && age < 18 ? "girl" : "woman") : age !== undefined && age < 18 ? "boy" : "man");

/**
 * The "VOICE CASTING" block for the GPT-Live session instructions, or [] when the persona has nothing to say. Gender, age
 * and emotion are repeated exactly as stated; nothing is guessed from a name, and what is not stated is labeled
 * unspecified instead of invented.
 */
export function liveCastingSection(p: LiveCastPersona): string[] {
  const delivery = p.liveDelivery?.trim();
  const emotion = p.emotion?.trim();
  if (!delivery && !emotion && !p.gender && p.age === undefined && !p.ageBand) return [];
  const maturity = maturityOf(p.age);
  const lines = [
    "VOICE CASTING AND DELIVERY",
    "- Your voice was chosen before the call started and cannot change. It does not carry your age or mood by itself, so you create them with pace, pitch, breath, word choice and how you speak.",
  ];
  if (p.gender && p.age !== undefined) lines.push(`- Who you are: ${article(p.age)} ${p.age}-year-old ${noun(p.gender, p.age)}, ${maturity}. Sound like exactly that person throughout.`);
  else {
    lines.push(p.age !== undefined ? `- Your age is ${p.age}, ${maturity}.` : p.ageBand ? `- Your age is in this band: ${p.ageBand}. No exact age is stated, so don't state one.` : "- Your age is not specified: don't announce or invent one.");
    lines.push(p.gender ? `- You are a ${noun(p.gender, p.age)}.` : "- Your gender is not specified: don't announce or invent one.");
  }
  if (emotion) lines.push(`- You start the call feeling ${emotion.toLowerCase()}, and that feeling stays in your voice as the call goes on.`);
  if (delivery) lines.push(`- Delivery: ${delivery}`);
  lines.push("- Never mention your voice, this casting or these notes. Keep the same accent and manner of speaking the whole call.");
  return lines;
}
