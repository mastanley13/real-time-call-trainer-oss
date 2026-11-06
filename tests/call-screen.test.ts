import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Deck from "@/components/call/Deck";
import { NextMove } from "@/components/call/CopilotRail";
import { CALL_HEADLINE, CALL_STATUS, CALL_TROUBLE_MESSAGE, callErrorText, namesVendorOrEnv, nextMoveCue } from "@/components/call/callCopy";
import type { LiveCue } from "@/components/call/useCoach";
import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { CAP_REACHED_MESSAGE, CAP_STOPPED_MESSAGE, type UsageSnapshot } from "@/lib/billingUi";

/**
 * The live call screen, "Buyer and brief". No DOM test setup in this repo and no real voice session or mic: the Deck is
 * rendered to markup with React's server renderer (effects do not run), and the rest is source checks.
 */
type DeckProps = Parameters<typeof Deck>[0];
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
/** Code only: comments may name a vendor, the UI may not. */
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");

const scenario = BUILT_IN_SCENARIOS[0];
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? "user" : "assistant") as "user" | "assistant", text: `Turn number ${i + 1} of the call.`, timestamp: new Date(1_900_000_000_000 + i * 5000).toISOString() }));
const cue = (id: string, over: Partial<LiveCue> = {}): LiveCue => ({ id, type: "objection", title: `Cue title ${id}`, message: `Cue message ${id}.`, suggestedLine: `Suggested line ${id}.`, triggerTurn: 1, status: "active", ...over });
const result: CoachResult = {
  estimate: { overall: 87, criteria: scenario.rubric.map((c) => ({ id: c.id, name: c.name, weight: c.weight, score: 61, confirmed: true, evidenceLine: 2 })) },
  steps: [true, false, false], cue: null, talkRatio: 0.5, source: "llm", latencyMs: 300,
};
const coach = (cues: LiveCue[] = [], error = "") => ({
  result, cues, chips: { 1: [{ id: "x", name: "Rubric chip", delta: 12 }] }, error, p50: 300,
  reset: () => {}, shift: () => {}, use: () => {}, dismiss: () => {},
}) as unknown as DeckProps["coach"];

const base = (over: Partial<DeckProps> = {}): DeckProps => ({
  scenario, turns: turns(3), startedAt: 1_900_000_000_000, elapsed: 74, status: { label: CALL_STATUS.listening, tone: "ok" }, grading: false,
  gradingLabel: "Graded by AI after the call", onEnd: () => {}, coach: coach([cue("c3"), cue("c2"), cue("c1")]), coachMode: "coached",
  onCoachModeChange: () => {}, coachLabel: "Coach: AI", inserted: false, onInsert: () => {}, ...over,
});
const voice = (over: Partial<NonNullable<DeckProps["voice"]>> = {}) => ({ muted: false, onToggleMute: () => {}, tier: "standard" as const, ...over });
const text = (over: Partial<NonNullable<DeckProps["text"]>> = {}) => ({ value: "", onChange: () => {}, onSend: () => {}, hungUp: false, typing: false, caller: "Text · AI", ...over });
const render = (over: Partial<DeckProps> = {}) => renderToStaticMarkup(createElement(Deck, base(over)));
const usage: UsageSnapshot = { remaining: 8, cap: 60 };

const VARIANTS: [string, Partial<DeckProps>][] = [
  ["voice, Standard", { voice: voice() }],
  ["voice, Premium trial", { voice: voice({ tier: "premium", trial: true }), usage }],
  ["voice, Premium last minutes", { voice: voice({ tier: "premium", nextCallStandard: true, maxSeconds: 120 }) }],
  ["voice, muted", { voice: voice({ muted: true }), status: { label: CALL_STATUS.muted, tone: "caution" } }],
  ["voice, tier not known yet", { voice: voice({ tier: undefined }), turns: [], status: { label: CALL_STATUS.allowMic, tone: "caution" } }],
  ["text, AI caller", { text: text(), usage }],
  ["text, scripted fallback", { text: text({ caller: "Text · scripted", typing: true }) }],
  ["text, hung up", { text: text({ hungUp: true }) }],
  ["grading", { voice: voice(), grading: true, status: { label: CALL_STATUS.grading, tone: "signal" } }],
  ["guided", { voice: voice(), coachMode: "guided" }],
  ["blind", { voice: voice(), coachMode: "blind" }],
  ["vendor error", { voice: voice(), error: "OpenAI rejected the API key. Check OPENAI_API_KEY and any OPENAI_API_KEY_BACKUP_* keys." }],
];

describe("call screen layout", () => {
  it("heads the conversation with the direction headline, under the persona name as the h1", () => {
    const html = render({ voice: voice() });
    expect(CALL_HEADLINE).toBe("Stay with the buyer.");
    expect(html).toContain(`<h2 id="call-headline" class="text-lg font-bold lg:text-xl">Stay with the buyer.</h2>`);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${scenario.aiPersona.name}</h1>`));
  });

  it("makes the transcript the primary pane (two thirds on wide screens) and the rail the compact third", () => {
    const html = render({ voice: voice() });
    expect(html).toContain("lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]");
    const conversation = html.indexOf('aria-labelledby="call-headline"');
    const rail = html.indexOf('<aside aria-label="Buyer brief and coaching"');
    expect(conversation).toBeGreaterThan(-1);
    expect(rail).toBeGreaterThan(conversation);
    // The rail holds the brief: goal and expected objections.
    expect(html).toContain("Buyer brief");
    expect(html).toContain(scenario.traineeGoal.replace(/'/g, "&#x27;"));
  });

  it("shows exactly one next move, the newest active cue, even with several active cues", () => {
    const html = render({ text: text() });
    expect(html.match(/data-next-move=""/g)).toHaveLength(1);
    expect(html.match(/>Use line</g)).toHaveLength(1);
    expect(html.match(/>Hide cue</g)).toHaveLength(1);
    const card = html.slice(html.indexOf("data-next-move"), html.indexOf("</section>", html.indexOf("data-next-move")));
    expect(card).toContain("Cue title c3");
    expect(card).not.toContain("Cue title c2");
    expect(card).toContain("Live coaching, not a final grade.");
  });

  it("never resurfaces an older cue once the newest is used or hidden", () => {
    expect(nextMoveCue([cue("new", { status: "dismissed" }), cue("old")])).toBeUndefined();
    expect(nextMoveCue([cue("new"), cue("old")])?.id).toBe("new");
    expect(nextMoveCue([])).toBeUndefined();
    const html = render({ voice: voice(), coach: coach([cue("c2", { status: "used" }), cue("c1")]) });
    const card = html.slice(html.indexOf("data-next-move"), html.indexOf("</section>", html.indexOf("data-next-move")));
    expect(card).toContain("No cue right now.");
  });

  it("shows no cue in Guided or Blind", () => {
    for (const coachMode of ["guided", "blind"] as const) expect(render({ voice: voice(), coachMode })).not.toContain("data-next-move");
  });
});

describe("no live scoreboard in the call", () => {
  it.each(VARIANTS)("%s: no overall /100, rubric meter, talk ratio or score chips", (_name, over) => {
    const html = render(over);
    expect(html).not.toContain("/100");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toMatch(/Live estimate|not final|You talk|Rubric/);
    expect(html).not.toContain(">87<");
    expect(html).not.toContain("Rubric chip");
    expect(html).not.toContain("+12");
  });

  it("the rail module no longer exports the score instruments", () => {
    const rail = read("src/components/call/CopilotRail.tsx");
    expect(rail).not.toMatch(/export function (Instruments|CriteriaTapes)/);
    expect(code("src/components/call/Deck.tsx")).not.toMatch(/estimate\.overall|CriteriaTapes|Instruments|coach\.chips/);
  });
});

describe("neutral names only", () => {
  // "Whisper" alone is a cue type; only the model name pattern counts here.
  const VENDOR = /OpenAI|Open AI|ElevenLabs|Eleven Labs|Realtime|gpt-|whisper-\d|anthropic|gemini/i;
  const ENV = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

  it.each(VARIANTS)("%s: no provider, model or setting names in text, aria-labels or titles", (_name, over) => {
    const html = render(over);
    expect(html).not.toMatch(VENDOR);
    expect(html).not.toMatch(ENV);
    expect(html).not.toContain("Voice · ");
  });

  it("labels the effective tier Standard voice or Premium voice", () => {
    expect(render({ voice: voice() })).toContain('<span class="badge-tag">Standard voice</span>');
    expect(render({ voice: voice({ tier: "premium" }) })).toContain('<span class="badge-tag">Premium voice</span>');
    // Before the mint answers there is no tier to show, and the request is never shown as if it were the tier.
    expect(render({ voice: voice({ tier: undefined }) })).not.toMatch(/Standard voice|Premium voice/);
  });

  it("call UI code holds no vendor strings, and the voice status words are the plain ones", () => {
    for (const f of ["src/components/call/Deck.tsx", "src/components/call/CopilotRail.tsx", "src/components/call/callCopy.ts", "src/components/call/RealtimeVoiceSession.tsx"]) {
      expect(code(f), f).not.toMatch(/["'`][^"'`\n]*\b(?:OpenAI|ElevenLabs)\b[^"'`\n]*["'`]/);
    }
    expect(read("src/components/TrainerClient.tsx")).not.toMatch(/Voice · (?:OpenAI|ElevenLabs)/);
    expect(CALL_STATUS.listening).toBe("Listening");
    expect(CALL_STATUS.muted).toBe("Muted");
    for (const f of ["src/components/call/RealtimeVoiceSession.tsx", "src/components/TrainerClient.tsx"]) {
      expect(read(f), f).toContain("CALL_STATUS.listening");
      expect(read(f), f).toContain("CALL_STATUS.muted");
    }
  });

  it("replaces an error that names a vendor or a setting, and passes cap messages through", () => {
    expect(callErrorText("OpenAI could not connect the voice call.")).toBe(CALL_TROUBLE_MESSAGE);
    expect(callErrorText("Check LLM_API_KEY on the server.")).toBe(CALL_TROUBLE_MESSAGE);
    expect(callErrorText("ElevenLabs session closed")).toBe(CALL_TROUBLE_MESSAGE);
    for (const m of [CAP_REACHED_MESSAGE, CAP_STOPPED_MESSAGE, "The voice connection dropped. Check your network. Your transcript so far is kept."]) {
      expect(callErrorText(m)).toBe(m);
    }
    expect(namesVendorOrEnv(CALL_TROUBLE_MESSAGE)).toBe(false);
    const html = render({ voice: voice(), error: "OpenAI rejected the API key. Check OPENAI_API_KEY." });
    expect(html).toContain(CALL_TROUBLE_MESSAGE);
  });
});

describe("header", () => {
  it("shows the persona, the call time, the status and the allowance at call start", () => {
    const html = render({ voice: voice(), usage });
    expect(html).toContain("1:14");
    expect(html).toContain("At call start:");
    expect(html).toContain("8 of 60 voice minutes left");
    // Text calls are never counted; the header says so instead of a minutes count.
    expect(render({ text: text(), usage })).toContain("Text practice is unlimited.");
    // Not metered: nothing, never a guessed count.
    expect(render({ voice: voice() })).not.toMatch(/minutes left|At call start/);
  });

  it("announces status changes in a polite live region, never an assertive one", () => {
    const html = render({ voice: voice({ muted: true }), status: { label: CALL_STATUS.muted, tone: "caution" } });
    expect(html).toMatch(/<p role="status" aria-live="polite" aria-atomic="true"[^>]*><span[^>]*><\/span>Muted<\/p>/);
    expect(html).not.toContain('aria-live="assertive"');
    expect(html).toContain("Unmute");
  });

  it("keeps the Premium notice in its polite region", () => {
    const html = render({ voice: voice({ tier: "premium", nextCallStandard: true, maxSeconds: 120 }) });
    expect(html).toMatch(/<p aria-live="polite"[^>]*>This call ends after 2 minutes, when your Premium minutes run out\./);
  });
});

describe("focus and motion", () => {
  it("no effect moves focus; the only focus() is the rep's own Use line click", () => {
    const deck = read("src/components/call/Deck.tsx");
    const effects = deck.split("useEffect(").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("}, [")));
    expect(effects.length).toBeGreaterThan(0);
    for (const body of effects) expect(body).not.toMatch(/focus\(/);
    expect(deck.match(/\.focus\(\)/g)).toHaveLength(1);
    const insert = deck.slice(deck.indexOf("function insertLine"), deck.indexOf("function endClicked"));
    expect(insert).toContain("replyRef.current?.focus()");
    // The cue card itself never grabs focus.
    const rail = read("src/components/call/CopilotRail.tsx");
    const next = rail.slice(rail.indexOf("export function NextMove"), rail.indexOf("export function TalkTrackPanel"));
    expect(next).not.toMatch(/autoFocus|data-autofocus|focus\(/);
  });

  it("animations are motion-safe, with no glow, gradient, orb or decorative icons", () => {
    for (const f of ["src/components/call/Deck.tsx", "src/components/call/CopilotRail.tsx"]) {
      const src = code(f);
      expect(src.match(/(?<!motion-safe:)animate-[a-z]/g), f).toBeNull();
      expect(src, f).not.toMatch(/gradient|shadow-glow|\blamp\b|CallOrb|Sparkle|Wand|Star\b/);
    }
  });
});

describe("phone layout and controls", () => {
  it("puts the brief and coach history in a titled disclosure", () => {
    const html = render({ voice: voice() });
    expect(html).toMatch(/<details data-phone-brief=""[^>]*><summary[^>]*>Buyer brief and coach settings<\/summary>/);
  });

  it("fits the open brief, the docked cue and the transcript in one height budget that never reaches the controls", () => {
    const html = render({ voice: voice() });
    // One phone column between header and controls; it is the only overflow path, and the controls sit outside it.
    const body = html.match(/<div data-call-body="" class="([^"]*)"/)![1].split(" ");
    expect(body).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "flex-col", "overflow-y-auto", "lg:overflow-visible", "lg:grid-rows-[minmax(0,1fr)]"]));
    expect(html).toContain('</aside></div><section aria-label="Call controls"');
    // The conversation section cannot shrink below its content on phones, so it never slides under the cue.
    const section = html.match(/<section aria-labelledby="call-headline" class="([^"]*)"/)![1].split(" ");
    expect(section).not.toContain("min-h-0");
    expect(section).toContain("lg:min-h-0");
    // The transcript keeps a minimum height.
    expect(html).toContain("min-h-[6rem] flex-1 overflow-y-auto");
    // Exactly two capped panels (brief body, cue dock), each capped by viewport and by rem, together well under the
    // screen; no bare viewport-only caps like the old 45dvh + 40dvh.
    const caps = [...html.matchAll(/max-h-\[min\((\d+)dvh,(\d+)rem\)\]/g)];
    expect(caps).toHaveLength(2);
    expect(caps.reduce((a, m) => a + Number(m[1]), 0)).toBeLessThanOrEqual(65);
    expect(caps.reduce((a, m) => a + Number(m[2]), 0)).toBeLessThanOrEqual(30);
    expect(html).not.toMatch(/max-h-\[\d+dvh\]/);
    // Both capped panels scroll inside their caps.
    expect(html).toMatch(/max-h-\[min\(30dvh,16rem\)\][^"]*overflow-y-auto/);
    expect(html).toMatch(/max-h-\[min\(35dvh,14rem\)\][^"]*overflow-y-auto/);
  });

  it("shrinks the docked cue to one line while the phone brief is open; wide screens keep the full card", () => {
    const deck = read("src/components/call/Deck.tsx");
    expect(deck).toContain("onToggle={(e) => setBriefOpen(e.currentTarget.open)}");
    expect(deck).toContain("compact={briefOpen}");
    const props = { voice: false, onUse: () => {}, onDismiss: () => {} };
    const slim = renderToStaticMarkup(createElement(NextMove, { ...props, cue: cue("c9"), compact: true }));
    expect(slim).toMatch(/<p data-cue-compact="" class="truncate[^"]*lg:hidden">Cue title c9<\/p>/);
    expect(slim).toContain("Close the brief to see it.");
    // Use line and Hide cue live only in the wide-screen body while the brief is open.
    const wideOnly = slim.indexOf('<div class="hidden lg:block">');
    expect(wideOnly).toBeGreaterThan(-1);
    expect(slim.indexOf(">Use line<")).toBeGreaterThan(wideOnly);
    expect(slim.indexOf(">Hide cue<")).toBeGreaterThan(wideOnly);
    // Brief closed: the full card at every width.
    const full = renderToStaticMarkup(createElement(NextMove, { ...props, cue: cue("c9"), compact: false }));
    expect(full).not.toContain("data-cue-compact");
    expect(full).not.toContain('<div class="hidden lg:block">');
    expect(full).toContain(">Use line<");
    // No cue: nothing to shrink.
    expect(renderToStaticMarkup(createElement(NextMove, { ...props, cue: undefined, compact: true }))).not.toContain("data-cue-compact");
  });

  it("keeps every earlier turn in the conversation scroller", () => {
    const many = turns(30);
    const html = render({ text: text(), turns: many });
    const log = html.slice(html.indexOf('aria-label="Conversation"'));
    expect(html.match(/data-turn=""/g)).toHaveLength(30);
    for (const t of many) expect(log).toContain(t.text);
    expect(html).toMatch(/role="region" aria-label="Conversation" tabindex="0"/);
  });

  it("gives the controls 48 px targets in a bar that clears the home indicator", () => {
    const deck = read("src/components/call/Deck.tsx");
    expect(deck).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
    expect(deck).toContain('aria-label="Call controls"');
    const html = render({ voice: voice() });
    const controls = html.slice(html.indexOf('aria-label="Call controls"'));
    expect(controls).toMatch(/min-h-\[48px\][^"]*"[^>]*>.*Mute/);
    expect(controls).toContain("End and grade");
    expect(render({ text: text() })).toMatch(/aria-label="Send"/);
  });

  it("injects no example copy into a real call", () => {
    for (const f of ["src/components/call/Deck.tsx", "src/components/call/CopilotRail.tsx", "src/components/call/callCopy.ts", "src/components/TrainerClient.tsx"]) {
      expect(read(f), f).not.toMatch(/What does a visit cost|Nobody mentioned a fee|Name the fee before/);
    }
  });
});
