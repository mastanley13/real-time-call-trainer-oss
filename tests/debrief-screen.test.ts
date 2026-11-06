import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import DebriefReport, { DebriefState, type DebriefReportProps, type DebriefView } from "@/components/debrief/DebriefReport";
import { DEBRIEF_HEADLINE, REGRADE_UNAVAILABLE, STATE_COPY, regradeErrorText } from "@/components/debrief/debriefCopy";
import { namesVendorOrEnv } from "@/components/call/callCopy";
import type { Evaluation } from "@/lib/grader-types";
import { BUILT_IN_SCENARIOS, type Scenario } from "@/lib/scenarios";

/**
 * The debrief, "Next move first". No DOM test setup in this repo: the report is rendered to markup with React's server
 * renderer (the page's effects and fetches don't run), and the rest is source checks. All names and lines are fictional.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
/** Code only: comments may name a vendor, the UI may not. */
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");
const FILES = ["src/app/trainer/debrief/[sessionId]/page.tsx", "src/components/debrief/DebriefReport.tsx", "src/components/debrief/debriefCopy.ts"];

const scenario: Scenario = {
  ...BUILT_IN_SCENARIOS[0],
  id: "test-furnace",
  title: "Furnace tune-up inbound call",
  aiPersona: { ...BUILT_IN_SCENARIOS[0].aiPersona, name: "Riley Park" },
  objections: [{ type: "price", line: "How much does the visit cost?", prepAnswer: "The tune-up is a flat 79 dollars and covers a full safety check." }],
};

const transcript = [
  { role: "assistant", text: "Hi, I am calling about a furnace tune-up." },
  { role: "user", text: "Thanks for calling. How old is the furnace?" },
  { role: "assistant", text: "About nine years. How much does the visit cost?" },
  { role: "user", text: "We can come Tuesday at 3 pm." },
  { role: "assistant", text: "Okay, Tuesday works." },
];

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  method: "llm",
  graderVersion: "llm-v2",
  // Legacy grades may still carry a model id; the page must never show it.
  model: "gpt-4.1-mini",
  overallScore: 62,
  grade: "D",
  summary: "You found the furnace age but booked before answering the price question.",
  criteria: [
    { id: "discovery", name: "Discovery questions", weight: 40, score: 80, rationale: "You asked how old the furnace is.", evidence: [{ speaker: "trainee", quote: "How old is the furnace?", line: 2 }] },
    {
      id: "pricing", name: "Pricing transparency", weight: 30, score: 30, rationale: "You offered a time before answering the cost question.",
      evidence: [
        { speaker: "caller", quote: "How much does the visit cost?", line: 3 },
        { speaker: "trainee", quote: "We can come Tuesday", line: 5 },
        { speaker: "trainee", quote: "We will waive the fee" },
      ],
    },
    { id: "booking", name: "Booking", weight: 30, score: 70, rationale: "You offered a clear slot.", evidence: [] },
  ],
  strengths: ["Asked about the unit's age."],
  improvements: ["Answer the cost question first."],
  goalAchievement: { achieved: false, status: "partial", explanation: "A slot was offered, but the price stayed open." },
  ...over,
});

const view = (over: Partial<DebriefView> = {}): DebriefView => ({
  title: scenario.title, scenario, scenarioId: scenario.id, createdAt: "2026-11-01T15:00:00.000Z", durationSeconds: 154,
  transcript, evaluation: evaluation(), callerName: scenario.aiPersona.name,
  coach: { mode: "coached", source: "llm", p50Ms: 1200, cues: [{ triggerTurn: 3, type: "objection", title: "Answer the price", used: false }] },
  ...over,
});
const render = (over: Partial<DebriefView> = {}, props: Partial<DebriefReportProps> = {}) =>
  renderToStaticMarkup(createElement(DebriefReport, { sessionId: "s-1", view: view(over), ...props }));
const section = (html: string, labelledby: string) => {
  const start = html.indexOf(`<section aria-labelledby="${labelledby}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const VARIANTS: [string, string][] = [
  ["AI grade", render()],
  ["rules-based grade", render({ evaluation: evaluation({ method: "heuristic", graderVersion: "heuristic-v2" }) })],
  ["not graded", render({ evaluation: null })],
  ["no evidence", render({ evaluation: evaluation({ criteria: evaluation().criteria.map((c) => ({ ...c, evidence: [] })) }) })],
  ["nothing said", render({ transcript: transcript.filter((t) => t.role === "assistant"), evaluation: null })],
  ["no transcript", render({ transcript: [], evaluation: null })],
  ["regrade unavailable", render({ evaluation: null }, { gradeControls: createElement("p", { role: "alert" }, regradeErrorText("AI grading isn't set up on this server. Add LLM_API_KEY to the server environment, then try again.")) })],
];

describe("next move first", () => {
  it("leads with the headline in the next move card, under the session title as the h1", () => {
    const html = render();
    expect(DEBRIEF_HEADLINE).toBe("Practice one better next question.");
    expect(html).toMatch(new RegExp(`<h2 id="next-h"[^>]*>${DEBRIEF_HEADLINE}</h2>`));
    expect(html).toMatch(new RegExp(`<h1[^>]*>${scenario.title}</h1>`));
    expect(section(html, "next-h")).toContain("Pricing transparency");
  });

  it("puts the next move before the score, the rubric and the transcript", () => {
    const html = render();
    const next = html.indexOf("data-next-move");
    expect(next).toBeGreaterThan(-1);
    expect(html.indexOf('aria-labelledby="score-h"')).toBeGreaterThan(next);
    expect(html.indexOf('id="rubric-h"')).toBeGreaterThan(html.indexOf('aria-labelledby="score-h"'));
    expect(html.indexOf('id="tx-h"')).toBeGreaterThan(html.indexOf('id="rubric-h"'));
  });

  it("labels Buyer said, What happened and Try saying, in that order, and keeps quote, reading and suggestion apart", () => {
    const card = section(render(), "next-h");
    const at = ["Buyer said", "What happened", "Try saying"].map((l) => card.indexOf(`>${l}</h3>`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(card).toContain("An interpretation, not a quote.");
    expect(card).toContain("A suggestion from this persona");
    expect(card).toContain("not a required script");
    expect(card).toContain("You offered a time before answering the cost question.");
    expect(card).toContain(scenario.objections[0].prepAnswer);
  });

  it("quotes the buyer word for word and links to that turn, which is a focusable target", () => {
    const html = render();
    const quoted = html.match(/data-exact-quote="">([^<]*)<\/span>/)![1];
    expect(quoted).toBe(transcript[2].text);
    const card = section(html, "next-h");
    expect(card).toContain('href="#turn-3"');
    expect(html).toMatch(/<li id="turn-3" tabindex="-1" data-turn=""/);
    // The target shows a visible focus outline.
    expect(html.match(/<li id="turn-3"[^>]*class="([^"]*)"/)![1]).toContain("focus:outline-primary");
  });

  it("omits a part the grade or the pack can't support instead of filling it in", () => {
    const card = section(render({ scenario: { ...scenario, objections: [] } }), "next-h");
    expect(card).not.toContain(">Try saying</h3>");
    expect(card).toContain(">Buyer said</h3>");
    const noReason = evaluation();
    noReason.criteria[1] = { ...noReason.criteria[1], rationale: "" };
    expect(section(render({ evaluation: noReason }), "next-h")).not.toContain(">What happened</h3>");
  });

  it("has exactly one retry, on the existing /trainer retry route, at the next move's turn", () => {
    const html = render();
    expect(html.match(/href="\/trainer\?retry=/g)).toHaveLength(1);
    expect(html.match(/data-retry=""/g)).toHaveLength(1);
    expect(section(html, "next-h")).toContain('href="/trainer?retry=s-1&amp;turn=3&amp;scenario=test-furnace"');
    expect(section(html, "next-h")).toContain("Retry from turn 3");
  });

  it("offers a plain practice link, not a retry, when there is no caller line to restart from", () => {
    const html = render({ transcript: [{ role: "user", text: "Hello?" }, { role: "user", text: "Anyone there?" }] });
    expect(html).not.toContain("retry=");
    expect(section(html, "next-h")).toContain("Practice this persona again");
  });
});

describe("evidence anchors", () => {
  it("anchors every quote link to a transcript turn that exists, and exact quotes match that turn's text", () => {
    const html = render();
    const links = [...html.matchAll(/href="#turn-(\d+)"/g)].map((m) => Number(m[1]));
    expect(links.length).toBeGreaterThan(2);
    for (const n of links) expect(html).toContain(`id="turn-${n}"`);
    const exact = [...html.matchAll(/<li data-quote="exact"[^>]*><blockquote[^>]*>“([^”]*)”<\/blockquote>.*?href="#turn-(\d+)"/g)];
    expect(exact).toHaveLength(2);
    for (const [, quote, n] of exact) expect(transcript[Number(n) - 1].text).toContain(quote);
  });

  it("labels a quote whose wording differs from its turn, and one that isn't in the transcript", () => {
    const html = render();
    expect(html.match(/data-quote="inexact"/g)).toHaveLength(1);
    expect(html).toContain("Not an exact quote. Wording differs from turn 5.");
    const unmatched = html.slice(html.indexOf('data-quote="unmatched"'));
    expect(unmatched).toContain("Unverified quote. It wasn&#x27;t found in this transcript.");
    expect(unmatched.slice(0, unmatched.indexOf("</li>"))).not.toContain("href=");
  });

  it("marks transcript turns as evidence only for exact quotes, and qualifies a cited turn whose wording differs", () => {
    const html = render();
    const turn = (n: number) => html.slice(html.indexOf(`<li id="turn-${n}"`), html.indexOf("</li>", html.indexOf(`<li id="turn-${n}"`)));
    expect(turn(2)).toContain(">Evidence for Discovery questions</p>");
    expect(turn(3)).toContain(">Evidence for Pricing transparency</p>");
    // Turn 5 is cited by "We can come Tuesday", which isn't its wording.
    expect(turn(5)).not.toContain("Evidence for");
    expect(turn(5)).toContain('data-cited="inexact"');
    expect(turn(5)).toContain("Cited for Pricing transparency, wording differs. Not verified evidence.");
    expect(html.match(/data-cited="inexact"/g)).toHaveLength(1);
  });

  it("warns that evidence is insufficient when every quote differs from its turn or has none", () => {
    const unverified = evaluation({
      criteria: evaluation().criteria.map((c) => ({ ...c, evidence: [{ speaker: "trainee" as const, quote: "We can come Tuesday", line: 5 }, { speaker: "trainee" as const, quote: "We will waive the fee" }] })),
    });
    const html = render({ evaluation: unverified });
    expect(html).toContain("data-insufficient-evidence");
    expect(text(html)).toContain("no quote in this grade matches the transcript word for word");
    expect(html).not.toContain("Evidence for");
    expect(html).toContain("Cited for Discovery questions, Pricing transparency, Booking, wording differs.");
  });

  it("says when a criterion has no evidence, and when no score has any", () => {
    expect(render()).toContain(STATE_COPY.noCriterionEvidence);
    const none = render({ evaluation: evaluation({ criteria: evaluation().criteria.map((c) => ({ ...c, evidence: [] })) }) });
    expect(none).toContain("data-insufficient-evidence");
    expect(text(none)).toContain("Not enough evidence");
    expect(render()).not.toContain("data-insufficient-evidence");
  });
});

describe("score", () => {
  it("keeps the real score secondary, with its definition, its limits and a link to the evidence", () => {
    const html = render();
    const score = section(html, "score-h");
    expect(score).toContain(">Final score</h2>");
    expect(score).toContain(">62<");
    expect(score).toContain("Grade D");
    expect(score).toContain("The weighted average of the rubric scores below.");
    expect(score).toContain("Based on this transcript only");
    expect(score).toContain('href="#rubric-h"');
    expect(score).toContain("Goal partly met");
    // Not a hero: no ring, no display-size number, and it is an h2 after the next move's h2.
    expect(score).not.toMatch(/<svg|text-[3-9]xl|text-\[[4-9]\d+px\]/);
    expect(html).not.toContain('role="img"');
  });

  it("calls a rules-based grade an estimate", () => {
    const score = section(VARIANTS[1][1], "score-h");
    expect(score).toContain(">Score estimate</h2>");
    expect(score).toContain("not an AI grade");
  });

  it("shows no score when there is none, and no improvement percentages anywhere", () => {
    for (const [name, html] of VARIANTS.filter(([n]) => ["not graded", "nothing said", "no transcript", "regrade unavailable"].includes(n))) {
      expect(html, name).not.toContain('aria-labelledby="score-h"');
      expect(html, name).not.toContain("/100");
    }
    for (const [name, html] of VARIANTS) {
      expect(text(html), name).not.toMatch(/[+−-]\s?\d+(?:\.\d+)?\s?%|\d+%\s*(?:better|higher|more|improve)|improved by|improvement of/i);
    }
  });
});

describe("states", () => {
  it.each(["notFound", "forbidden", "notLocal", "loadFailed"] as const)("%s: plain copy and one next action", (k) => {
    const s = STATE_COPY[k];
    const html = renderToStaticMarkup(createElement(DebriefState, { ...s, href: "/dashboard", headingLevel: 1 }));
    expect(html).toMatch(new RegExp(`<h1 id="state-h"[^>]*>${s.title.replace(/'/g, "&#x27;")}</h1>`));
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`>${s.action}</a>`);
    expect(`${s.title} ${s.body}`).not.toMatch(/[–—]/);
  });

  it("deleted or unknown sessions say so", () => {
    expect(STATE_COPY.notFound.title).toBe("We couldn't find this session");
    expect(STATE_COPY.notFound.body).toContain("deleted");
  });

  it("a call with no transcript, or where the rep said nothing, has no score or next move", () => {
    for (const [name, key] of [["no transcript", "noTranscript"], ["nothing said", "nothingSaid"]] as const) {
      const html = VARIANTS.find(([n]) => n === name)![1];
      expect(text(html)).toContain(STATE_COPY[key].title.replace(/&#x27;/g, "'"));
      expect(html).not.toContain("data-next-move");
      expect(html).not.toContain('aria-labelledby="score-h"');
      expect(html).toContain(">Practice again</a>");
    }
  });

  it("an ungraded call says so, keeps the transcript and shows the re-grade controls", () => {
    const html = render({ evaluation: null }, { gradeControls: createElement("button", { type: "button" }, "Re-grade with AI") });
    expect(html).toContain(">This call wasn&#x27;t graded</h2>");
    expect(html).toContain("Re-grade with AI");
    expect(html).toContain('id="tx-h"');
    expect(html).not.toContain("data-next-move");
  });

  it("replaces a re-grade error that names a setting or provider", () => {
    expect(regradeErrorText("AI grading isn't set up on this server. Add LLM_API_KEY to the server environment, then try again.")).toBe(REGRADE_UNAVAILABLE);
    expect(regradeErrorText("OpenAI quota exceeded")).toBe(REGRADE_UNAVAILABLE);
    const plain = "You've re-graded 5 calls in 10 minutes. Wait 3 minutes and try again.";
    expect(regradeErrorText(plain)).toBe(plain);
    expect(namesVendorOrEnv(REGRADE_UNAVAILABLE)).toBe(false);
  });
});

describe("structure and names", () => {
  // "Whisper" alone is a cue type; only the model name pattern counts here.
  const VENDOR = /OpenAI|Open AI|ElevenLabs|Eleven Labs|Realtime|gpt-|whisper-\d|anthropic|gemini|claude-/i;
  const ENV = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

  it.each(VARIANTS)("%s: no provider, model or setting names in text, aria-labels or titles", (_name, html) => {
    expect(html).not.toMatch(VENDOR);
    expect(html).not.toMatch(ENV);
  });

  it.each(VARIANTS)("%s: no play, record or share controls, and no media", (_name, html) => {
    expect(html).not.toMatch(/<audio|<video/);
    expect(text(html)).not.toMatch(/\b(?:Play|Pause|Record|Recording|Playback|Share)\b/);
  });

  it.each(VARIANTS)("%s: headings in order from one h1, and every section is named by a heading that exists", (_name, html) => {
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    for (const [, id] of html.matchAll(/<section aria-labelledby="([^"]+)"/g)) expect(html).toContain(`id="${id}"`);
  });

  it("source: tokens only, no sparkle, star or wand icons, no gradients or glow, motion-safe animation, no telemetry", () => {
    for (const f of FILES) {
      const src = code(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(\d/);
      expect(src, f).not.toMatch(/\b(?:slate|gray|zinc|red|green|blue|amber|emerald|cyan)-\d{2,3}\b/);
      expect(src, f).not.toMatch(/gradient|shadow-glow|Sparkle|Wand|\bStar\b|\blamp\b|dark:/);
      expect(src.match(/(?<!motion-safe:)animate-[a-z]/g), f).toBeNull();
      expect(src, f).not.toMatch(/p50/);
      expect(src, f).not.toMatch(/[–—]/);
    }
    // The old dark deck panel and score ring are gone from the debrief.
    expect(read(FILES[0])).not.toMatch(/className="deck|ScoreRing/);
  });

  it("injects no illustrative example copy into a real debrief", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/What does a visit cost|Nobody mentioned a fee|\$89|Dana Whitfield|Answer the price question before you offer a time slot/);
  });

  it("follows the theme: shared tokens and the in-call transcript type, no forced dark scope", () => {
    const html = render();
    expect(html).not.toMatch(/class="deck\b/);
    expect(html).toContain("site-wrap");
    expect(html).toContain("focus-strong");
    expect(html).toContain("text-[18px] leading-7 text-ink lg:text-[20px] lg:leading-[31px]");
  });
});
