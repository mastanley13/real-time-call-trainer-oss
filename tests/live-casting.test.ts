import { describe, expect, it } from "vitest";
import { LIBRARY } from "@/lib/personas";
import { LIVE_CASTING, UNSPECIFIED_GENDER } from "@/lib/personaLiveCasting";
import { LIVE_CAST_VOICES, LIVE_VOICE_PROFILES, liveCastFits, liveCastingSection, maturityOf } from "@/lib/liveCasting";
import { buildLiveInstructions, liveSessionBody, openAiVoiceApi, pickLiveVoice } from "@/lib/live";
import { ScenarioSchema } from "@/lib/scenarios";

/** The official GPT-Live voices from OpenAI's voice list, plus marin (the default) and cedar (kept where it already was). */
const OFFICIAL = ["gleam", "meridian", "delta", "cinder", "quartz", "ripple", "vesper", "willow", "stone", "marin", "cedar"];
const NORTH_AMERICAN = ["gleam", "meridian", "marin", "cedar"];
/** Everything the persona says about itself, in its own text. */
const textOf = (s: (typeof LIBRARY)[number]) =>
  [s.title, s.callScript, s.traineeGoal, s.aiPersona.role, s.aiPersona.behavior, s.aiPersona.openingLine, ...s.rubric.map((r) => r.description), ...s.objections.flatMap((o) => [o.line, o.prepAnswer]), ...s.sampleReplies].join("\n");

describe("official GPT-Live voices", () => {
  it("lists only the documented voices, with the documented gender and accent", () => {
    expect([...LIVE_CAST_VOICES].sort()).toEqual([...OFFICIAL].sort());
    expect(LIVE_VOICE_PROFILES.gleam).toEqual({ gender: "female", accent: "North American" });
    expect(LIVE_VOICE_PROFILES.meridian).toEqual({ gender: "male", accent: "North American" });
    expect(LIVE_VOICE_PROFILES.delta).toEqual({ gender: "female", accent: "Southern US" });
    expect(LIVE_VOICE_PROFILES.cinder).toEqual({ gender: "male", accent: "Southern US" });
    expect(LIVE_VOICE_PROFILES.quartz).toEqual({ gender: "female", accent: "Australian" });
    expect(LIVE_VOICE_PROFILES.ripple).toEqual({ gender: "male", accent: "Australian" });
    expect(LIVE_VOICE_PROFILES.vesper).toEqual({ gender: "male", accent: "British" });
    expect(LIVE_VOICE_PROFILES.willow).toEqual({ gender: "female", accent: "Irish" });
    expect(LIVE_VOICE_PROFILES.stone).toEqual({ gender: "male", accent: "Irish" });
    expect(LIVE_VOICE_PROFILES.marin.gender).toBe("neutral");
  });

  it("casts a gendered voice only for a stated gender, and marin for an unstated one", () => {
    expect(liveCastFits("gleam", "female")).toBe(true);
    expect(liveCastFits("marin", "female")).toBe(true);
    expect(liveCastFits("marin", "male")).toBe(false);
    expect(liveCastFits("gleam", "male")).toBe(false);
    expect(liveCastFits("meridian", "male")).toBe(true);
    expect(liveCastFits("cedar", "male")).toBe(true);
    expect(liveCastFits("cedar", "female")).toBe(false);
    expect(liveCastFits("marin", undefined)).toBe(true);
    expect(liveCastFits("gleam", undefined)).toBe(false);
    expect(liveCastFits("alloy", undefined)).toBe(false);
  });
});

describe("every active library persona is cast", () => {
  it("has exactly one casting line per persona, with no orphans", () => {
    expect(LIBRARY.length).toBe(54);
    expect(Object.keys(LIVE_CASTING).sort()).toEqual(LIBRARY.map((s) => s.id).sort());
  });

  it("gives every persona an official North American voice that fits what it states, and delivery notes", () => {
    const bad: string[] = [];
    for (const s of LIBRARY) {
      const p = s.aiPersona;
      if (!p.liveVoice || !NORTH_AMERICAN.includes(p.liveVoice)) bad.push(`${s.id}: voice ${p.liveVoice}`);
      if (!liveCastFits(p.liveVoice, p.gender)) bad.push(`${s.id}: ${p.liveVoice} does not suit ${p.gender ?? "an unstated gender"}`);
      if (!p.liveDelivery || p.liveDelivery.length < 20 || p.liveDelivery.length > 400) bad.push(`${s.id}: delivery length`);
      if (!p.emotion) bad.push(`${s.id}: no emotion`);
    }
    expect(bad).toEqual([]);
  });

  it("states a gender only where the persona's own full text uses a pronoun or relationship word for it, never from a name", () => {
    const female = /\b(she|her|hers|herself)\b/i;
    const male = /\b(he|his|him|himself)\b|\bmy wife\b|\byour wife\b/i;
    for (const s of LIBRARY) {
      const { gender } = s.aiPersona;
      if (gender === "female") expect(female.test(textOf(s)), `${s.id} has no female pronoun in its text`).toBe(true);
      if (gender === "male") expect(male.test(textOf(s)), `${s.id} has no male pronoun in its text`).toBe(true);
    }
  });

  it("leaves exactly the six personas that never state a gender unspecified", () => {
    const unspecified = LIBRARY.filter((s) => !s.aiPersona.gender).map((s) => s.id).sort();
    expect(unspecified).toEqual([...UNSPECIFIED_GENDER].sort());
    expect(unspecified).toHaveLength(6);
    // Their own role lines state nothing either.
    for (const s of LIBRARY.filter((x) => !x.aiPersona.gender)) expect(/\b(she|her|hers|he|his|him)\b/i.test(s.aiPersona.role), s.id).toBe(false);
  });

  it("spreads stated women across gleam and marin, stated men across meridian and cedar", () => {
    const count = (g: "female" | "male", v: string) => LIBRARY.filter((s) => s.aiPersona.gender === g && s.aiPersona.liveVoice === v).length;
    for (const s of LIBRARY.filter((x) => x.aiPersona.gender === "female")) expect(["gleam", "marin"], s.id).toContain(s.aiPersona.liveVoice);
    for (const s of LIBRARY.filter((x) => x.aiPersona.gender === "male")) expect(["meridian", "cedar"], s.id).toContain(s.aiPersona.liveVoice);
    expect(count("female", "gleam")).toBe(13);
    expect(count("female", "marin")).toBe(14);
    expect(count("male", "meridian")).toBe(13);
    expect(count("male", "cedar")).toBe(8);
    expect(LIBRARY.filter((s) => !s.aiPersona.gender && s.aiPersona.liveVoice === "marin")).toHaveLength(6);
  });

  it("states an age only where a number appears in the persona's own text", () => {
    for (const s of LIBRARY) {
      const { age, role, behavior } = s.aiPersona;
      if (age !== undefined) expect(new RegExp(`\\b${age}\\b`).test(`${role} ${behavior}`), s.id).toBe(true);
    }
  });

  it("uses marin, and says gender and age are unspecified, for a persona that states neither", () => {
    const plain = LIBRARY.filter((s) => !s.aiPersona.gender && s.aiPersona.age === undefined);
    expect(plain).toHaveLength(6);
    for (const s of plain) {
      expect(s.aiPersona.liveVoice, s.id).toBe("marin");
      const text = buildLiveInstructions(s);
      expect(text, s.id).toContain("Your gender is not specified");
      expect(text, s.id).toContain("Your age is not specified");
    }
  });

  it("does not change the persona's own prompt, role or behavior, and adds no Realtime voice", () => {
    for (const s of LIBRARY) {
      const parsed = ScenarioSchema.parse(s);
      expect(parsed.aiPersona.realtimeVoice, s.id).toBeUndefined();
      expect(s.aiPersona.behavior.length, s.id).toBeGreaterThan(50);
    }
  });
});

describe("casting in the GPT-Live session", () => {
  it("picks the persona's cast voice and puts delivery, age and emotion in the instructions", () => {
    for (const s of LIBRARY) {
      expect(pickLiveVoice(s.aiPersona), s.id).toBe(s.aiPersona.liveVoice);
      const text = buildLiveInstructions(s);
      expect(text, s.id).toContain("VOICE CASTING AND DELIVERY");
      expect(text, s.id).toContain(`Delivery: ${s.aiPersona.liveDelivery}`);
      expect(text, s.id).toContain(`feeling ${s.aiPersona.emotion}`);
      expect(text, s.id).toContain("Delegation policy:");
      if (s.aiPersona.age !== undefined) expect(text, s.id).toContain(`${s.aiPersona.age}-year-old`);
    }
  });

  it("sends the cast voice in audio.output.voice and the notes in session.instructions, with no transcription model", () => {
    const s = LIBRARY.find((x) => x.id === "mortgage-first-time-buyer-preapproval")!;
    const body = liveSessionBody({ model: "m", voice: pickLiveVoice(s.aiPersona), instructions: buildLiveInstructions(s), openingLine: s.aiPersona.openingLine, sdp: "v=0" });
    expect(body.session.audio).toEqual({ output: { voice: "meridian" } });
    expect(body.session.instructions).toContain("a 29-year-old man, a young adult");
    expect(JSON.stringify({ ...body.session, instructions: undefined, input: undefined })).not.toMatch(/transcri|whisper|input_audio/i);
  });

  it("stays off unless OPENAI_VOICE_API=live", () => {
    expect(openAiVoiceApi({})).toBe("realtime");
    expect(openAiVoiceApi({ OPENAI_VOICE_API: "" })).toBe("realtime");
  });

  it("labels what is not stated, and says nothing for a persona with nothing to cast", () => {
    expect(liveCastingSection({ emotion: "calm" }).join("\n")).toContain("Your gender is not specified");
    expect(liveCastingSection({ gender: "female", liveDelivery: "Unhurried, even." }).join("\n")).toContain("Your age is not specified");
    expect(liveCastingSection({ ageBand: "teen (17 to 19)" }).join("\n")).toContain("No exact age is stated");
    expect(liveCastingSection({})).toEqual([]);
    expect(maturityOf(29)).toBe("a young adult");
    expect(maturityOf(61)).toBe("an older adult");
    expect(maturityOf(undefined)).toBeNull();
  });
});

describe("saved and wizard-made scenarios", () => {
  const base = LIBRARY[0];
  const { liveVoice: _v, liveDelivery: _d, gender: _g, age: _a, emotion: _e, ...plain } = base.aiPersona;

  it("still parse and run without any casting fields, and reject nothing new", () => {
    const saved = ScenarioSchema.parse({ ...base, aiPersona: plain });
    expect(saved.aiPersona.liveVoice).toBeUndefined();
    expect(buildLiveInstructions(saved)).not.toContain("VOICE CASTING AND DELIVERY");
    expect(pickLiveVoice(saved.aiPersona)).toBe("marin");
  });

  it("accepts a custom persona that names its own live voice and delivery", () => {
    const custom = ScenarioSchema.parse({ ...base, aiPersona: { ...plain, liveVoice: "willow", liveDelivery: "Gentle and unhurried." } });
    expect(buildLiveInstructions(custom)).toContain("Delivery: Gentle and unhurried.");
    expect(pickLiveVoice(custom.aiPersona)).toBe("willow");
  });
});
