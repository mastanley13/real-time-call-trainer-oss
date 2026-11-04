import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_REPLIES, FIRST_RUN_SECONDS, autoFinishDue, autoFinishGate, callGeneration, firstRunMarkerKey, hasStartedFirstRun, isFirstRun,
  markFirstRunStarted, repliesSent, trainerView, withFirstRun,
} from "@/lib/firstRun";
import { afterSignin } from "@/lib/checkoutStart";
import { countSavedSessions } from "@/lib/sessionStore";
import { STARTER_SCENARIO_ID } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import FirstRunBar, { FIRST_GRADED_COPY, FirstGradedNote } from "@/components/call/FirstRunBar";

const q = (s = "") => new URLSearchParams(s);
const DASH = new RegExp("[\\u2013\\u2014]");
type T = { role: "user" | "assistant"; text: string };
const opening: T = { role: "assistant", text: "Hi, my water heater is leaking." };
const me = (text = "Hello"): T => ({ role: "user", text });
const them = (text = "Okay."): T => ({ role: "assistant", text });

describe("isFirstRun", () => {
  it("is true for a signed-in user with no saved sessions", () => {
    expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q() })).toBe(true);
  });

  it("is false once the user has a saved session", () => {
    expect(isFirstRun({ authenticated: true, sessionCount: 1, params: q() })).toBe(false);
    expect(isFirstRun({ authenticated: true, sessionCount: 12, params: q() })).toBe(false);
  });

  it("is false with ?scenario or ?retry, even with no sessions or ?firstrun=1", () => {
    for (const s of ["scenario=sdr-cold-1", "retry=abc&turn=3", "scenario=x&firstrun=1", "retry=abc&turn=2&firstrun=1"]) {
      expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q(s) })).toBe(false);
    }
  });

  it("?firstrun=1 forces it for a signed-in user, whatever the session count", () => {
    expect(isFirstRun({ authenticated: true, sessionCount: 5, params: q("firstrun=1") })).toBe(true);
    expect(isFirstRun({ authenticated: true, sessionCount: null, params: q("firstrun=1") })).toBe(true);
    expect(isFirstRun({ authenticated: true, sessionCount: 5, params: q("firstrun=0") })).toBe(false);
  });

  it("is false when signed out, or when the session list could not be read", () => {
    expect(isFirstRun({ authenticated: false, sessionCount: 0, params: q() })).toBe(false);
    expect(isFirstRun({ authenticated: false, sessionCount: 0, params: q("firstrun=1") })).toBe(false);
    expect(isFirstRun({ authenticated: true, sessionCount: null, params: q() })).toBe(false);
  });
});

describe("countSavedSessions", () => {
  const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("reads the server list for stored accounts", async () => {
    const f = answer(200, { sessions: [{ id: "a" }, { id: "b" }] });
    expect(await countSavedSessions(true, f as unknown as typeof fetch)).toBe(2);
    expect(f.mock.calls[0][0]).toBe("/api/transcripts");
    expect(await countSavedSessions(true, answer(200, { sessions: [] }) as unknown as typeof fetch)).toBe(0);
  });

  it("fails closed (null) when the server list cannot be read", async () => {
    expect(await countSavedSessions(true, answer(500, {}) as unknown as typeof fetch)).toBeNull();
    expect(await countSavedSessions(true, answer(200, { nope: 1 }) as unknown as typeof fetch)).toBeNull();
    expect(await countSavedSessions(true, vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch)).toBeNull();
  });

  it("uses only the browser store in demo mode, without a request", async () => {
    const f = vi.fn();
    expect(await countSavedSessions(false, f as unknown as typeof fetch)).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  describe("with someone's browser-stored sessions in this browser", () => {
    const local = [{ id: "local-a", createdAt: "2026-11-01T10:00:00Z" }, { id: "local-b", createdAt: "2026-11-02T10:00:00Z" }];
    beforeEach(() => { vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "rtct.sessions.v1" ? JSON.stringify(local) : null) }); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it("a stored account counts only its own server sessions, so a new user still gets first run", async () => {
      expect(await countSavedSessions(true, answer(200, { sessions: [] }) as unknown as typeof fetch)).toBe(0);
      expect(await countSavedSessions(true, answer(200, { sessions: [{ id: "s1" }] }) as unknown as typeof fetch)).toBe(1);
    });

    it("demo mode counts the browser store", async () => {
      expect(await countSavedSessions(false)).toBe(2);
    });
  });
});

describe("auto-finish", () => {
  it("is not due until the third reply has its caller answer", () => {
    expect(autoFinishDue([opening], 10)).toBe(false);
    expect(autoFinishDue([opening, me(), them(), me(), them()], 30)).toBe(false);
    expect(autoFinishDue([opening, me(), them(), me(), them(), me()], 40)).toBe(false);
    expect(autoFinishDue([opening, me(), them(), me(), them(), me(), them()], 45)).toBe(true);
    // Two lines sent before the caller answered still count as replies.
    expect(autoFinishDue([opening, me(), me(), them(), me(), them()], 45)).toBe(true);
    // Blank lines are not replies.
    expect(autoFinishDue([opening, me(), them(), me(" "), them(), me(), them()], 45)).toBe(false);
  });

  it("is due at 300 seconds, whatever the reply count", () => {
    expect(FIRST_RUN_SECONDS).toBe(300);
    expect(autoFinishDue([opening], 299)).toBe(false);
    expect(autoFinishDue([opening], 300)).toBe(true);
    expect(autoFinishDue([opening, me(), them()], 301)).toBe(true);
  });

  it("fires once at turn 3, then never again", () => {
    const gate = autoFinishGate();
    const calls: string[] = [];
    const tick = (turns: T[], s: number) => { if (gate.check(turns, s)) calls.push(`${turns.length}@${s}`); };
    const turns: T[] = [opening];
    let s = 0;
    for (let i = 0; i < FIRST_RUN_REPLIES; i++) {
      turns.push(me(`Reply ${i + 1}`)); tick(turns, ++s);
      turns.push(them()); tick(turns, ++s);
    }
    // More turns, more ticks and the 300 s mark all come after it fired.
    turns.push(me("A fourth line"), them());
    for (const t of [s + 1, s + 2, 300, 301, 600]) tick(turns, t);
    expect(calls).toEqual(["7@6"]);
    expect(gate.fired).toBe(true);
  });

  it("fires once at 300 s, then never again", () => {
    const gate = autoFinishGate();
    const turns: T[] = [opening, me(), them()];
    const fired = [] as number[];
    for (let s = 290; s <= 320; s++) if (gate.check(turns, s)) fired.push(s);
    turns.push(me(), them(), me(), them());
    if (gate.check(turns, 321)) fired.push(321);
    expect(fired).toEqual([300]);
  });

  it("reset arms it again for a new call", () => {
    const gate = autoFinishGate();
    expect(gate.check([opening], 300)).toBe(true);
    expect(gate.check([opening], 301)).toBe(false);
    gate.reset();
    expect(gate.check([opening], 300)).toBe(true);
  });

  it("counts replies for the bar", () => {
    expect(repliesSent([opening])).toBe(0);
    expect(repliesSent([opening, me(), them(), me("  "), me("x")])).toBe(2);
  });

  it("the trainer calls the existing finish() from the gate, with no second grading path", () => {
    const src = readFileSync("src/components/TrainerClient.tsx", "utf8");
    expect(src).toContain("if (autoFinish.current.check(turns, elapsed)) void finish();");
    expect(src.match(/\/api\/evaluate-call/g)?.length).toBe(1);
  });
});

describe("afterSignin", () => {
  it("appends firstrun=1 on the /trainer branch only, and only for a new account", () => {
    expect(afterSignin(false, {}, true).path).toBe("/trainer?firstrun=1");
    expect(afterSignin(false, { plan: "pro", interval: "month" }, true).path).toBe("/trainer?firstrun=1");
    expect(afterSignin(true, {}, true).path).toBe("/trainer?firstrun=1");
    expect(afterSignin(true, { plan: "pro", interval: "year" }, true).path).toBe("/checkout/start?plan=pro&interval=year");
    expect(afterSignin(true, { plan: "team" }, true).path).not.toContain("firstrun");
  });

  it("never appends it for a user who was already signed in", () => {
    expect(afterSignin(false, {}).path).toBe("/trainer");
    expect(afterSignin(true, {}, false).path).toBe("/trainer");
    expect(afterSignin(false, { plan: "pro" }, false).path).toBe("/trainer");
  });
});

describe("withFirstRun", () => {
  it("adds the flag to a plain /trainer, keeping its other query values", () => {
    expect(withFirstRun("/trainer")).toBe("/trainer?firstrun=1");
    expect(withFirstRun("/trainer?src=pricing")).toBe("/trainer?src=pricing&firstrun=1");
    expect(withFirstRun("/trainer?firstrun=1")).toBe("/trainer?firstrun=1");
  });

  it("leaves every other path, and a /trainer that names a persona or retry, unchanged", () => {
    for (const p of ["/library", "/checkout/start?plan=pro&interval=month", "/trainer?scenario=x", "/trainer?retry=abc&turn=2", "/trainer/debrief/abc", "/dashboard"]) {
      expect(withFirstRun(p)).toBe(p);
    }
  });
});

describe("abandoned first visit", () => {
  it("a saved last persona or the per-user marker turns first run off", () => {
    expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q(), lastScenario: true })).toBe(false);
    expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q(), started: true })).toBe(false);
    expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q(), lastScenario: false, started: false })).toBe(true);
  });

  it("?firstrun=1 still forces it as a testing override", () => {
    expect(isFirstRun({ authenticated: true, sessionCount: 3, params: q("firstrun=1"), lastScenario: true, started: true })).toBe(true);
    expect(isFirstRun({ authenticated: true, sessionCount: 0, params: q("firstrun=1&scenario=x"), lastScenario: false })).toBe(false);
  });

  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("the marker is kept per user id", () => {
    const store = memory();
    expect(hasStartedFirstRun("u-1", store)).toBe(false);
    markFirstRunStarted("u-1", store);
    expect(hasStartedFirstRun("u-1", store)).toBe(true);
    expect(hasStartedFirstRun("u-2", store)).toBe(false);
    expect([...store.m.keys()]).toEqual([firstRunMarkerKey("u-1")]);
    expect(firstRunMarkerKey("u-1")).toBe("rtct.firstRunStarted.u-1");
  });

  it("no user id, or blocked storage, never throws and reads as not started", () => {
    const store = memory();
    markFirstRunStarted(undefined, store);
    expect(store.m.size).toBe(0);
    expect(hasStartedFirstRun(undefined, store)).toBe(false);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => markFirstRunStarted("u-1", blocked)).not.toThrow();
    expect(hasStartedFirstRun("u-1", blocked)).toBe(false);
  });

  it("the trainer checks the last persona and marker, and sets the marker when the first-run call begins", () => {
    const src = readFileSync("src/components/TrainerClient.tsx", "utf8");
    expect(src).toContain("lastScenario = !!localStorage.getItem(LAST_SCENARIO)");
    expect(src).toContain("started: hasStartedFirstRun(userId)");
    expect(src).toMatch(/setFirstRun\("on"\);[\s\S]{0,200}markFirstRunStarted\(userId\);[\s\S]{0,40}beginRef\.current\(\);/);
  });
});

describe("call generation", () => {
  it("a reply started for one call is stale once a new call begins or the call is left", () => {
    const gen = callGeneration();
    const first = gen.next();
    expect(gen.isCurrent(first)).toBe(true);
    // Switch to voice.
    gen.next();
    expect(gen.isCurrent(first)).toBe(false);
    // A new call after that: the old reply stays stale.
    const third = gen.next();
    expect(gen.isCurrent(first)).toBe(false);
    expect(gen.isCurrent(third)).toBe(true);
    expect(gen.current).toBe(third);
  });

  it("a stale text reply is dropped, with its hang-up, by drainReplies", async () => {
    // Model of drainReplies: the guard is read after the reply comes back.
    const gen = callGeneration();
    let turns: T[] = [opening, me()];
    let hungUp = false;
    let answer!: (v: { reply: string; ended: boolean }) => void;
    const pending = new Promise<{ reply: string; ended: boolean }>((r) => { answer = r; });
    const callGen = gen.next();
    const drain = (async () => {
      const data = await pending;
      if (!gen.isCurrent(callGen)) return;
      turns = [...turns, them(data.reply)];
      if (data.ended) hungUp = true;
    })();
    // Switch to voice, then begin a new call while the old reply is in flight.
    gen.next();
    turns = [opening];
    gen.next();
    answer({ reply: "Bye.", ended: true });
    await drain;
    expect(turns).toEqual([opening]);
    expect(hungUp).toBe(false);
  });

  it("the trainer bumps the generation on begin and on switch to voice, and drainReplies checks it", () => {
    const src = readFileSync("src/components/TrainerClient.tsx", "utf8");
    const body = (name: string) => src.slice(src.indexOf(`function ${name}(`), src.indexOf("\n  }\n", src.indexOf(`function ${name}(`)));
    expect(body("begin")).toContain("callGen.current.next();");
    expect(body("switchToVoice")).toContain("callGen.current.next();");
    const drain = body("drainReplies");
    expect(drain).toContain("const gen = callGen.current.current;");
    expect(drain).toContain("if (finishing.current || stale()) break;");
    expect(drain).toMatch(/while \(!finishing\.current && !stale\(\)/);
  });
});

describe("trainer view", () => {
  it("a first run renders the deck, never the briefing", () => {
    expect(trainerView("idle", "deciding")).toBe("skeleton");
    expect(trainerView("idle", "start")).toBe("skeleton");
    expect(trainerView("live", "on")).toBe("deck");
    expect(trainerView("grading", "on")).toBe("deck");
  });

  it("a later visit renders the briefing as today", () => {
    expect(trainerView("idle", "off")).toBe("briefing");
    expect(trainerView("live", "off")).toBe("deck");
  });

  it("the starter persona is a reviewed built-in in the library", () => {
    const s = LIBRARY.find((x) => x.id === STARTER_SCENARIO_ID);
    expect(s?.builtIn).toBe(true);
    expect(s?.status).toBe("reviewed");
    expect(s?.aiPersona.openingLine.length).toBeGreaterThan(0);
  });
});

describe("first-run UI", () => {
  it("the bar states the target, counts replies in a polite live region and offers voice", () => {
    const html = renderToStaticMarkup(createElement(FirstRunBar, { replies: 1, onSwitchToVoice: () => {} }));
    expect(html).toContain("Practice call 1 of 1:</span> reply 3 times, then we grade it. No mic needed.");
    expect(html).toMatch(/aria-live="polite"[^>]*>[\s\S]*Replies sent: 1 of 3/);
    expect(html).toContain(">1/3</span>");
    expect(html).toContain("Switch to voice");
    expect(html).not.toMatch(DASH);
  });

  it("the counter starts at 0/3, caps at 3/3, and hides voice when the server has none", () => {
    const start = renderToStaticMarkup(createElement(FirstRunBar, { replies: 0 }));
    expect(start).toContain(">0/3</span>");
    expect(start).toContain("Replies sent: 0 of 3");
    const done = renderToStaticMarkup(createElement(FirstRunBar, { replies: 5 }));
    expect(done).toContain(">3/3</span>");
    expect(done).not.toContain("Switch to voice");
  });

  it("the debrief line has the copy and both next steps, with no upsell", () => {
    const html = renderToStaticMarkup(createElement(FirstGradedNote, { scenarioId: STARTER_SCENARIO_ID }));
    expect(html).toContain(FIRST_GRADED_COPY.replace("'", "&#x27;"));
    expect(html).toContain(`href="/trainer?scenario=${STARTER_SCENARIO_ID}&amp;mode=text"`);
    expect(html).toContain(`href="/trainer?scenario=${STARTER_SCENARIO_ID}&amp;mode=voice"`);
    expect(html).toContain("Practice again (text)");
    expect(html).toContain("Try voice");
    expect(html).not.toMatch(/upgrade|pricing|billing/i);
    expect(html).not.toMatch(DASH);
  });

  it("new first-run copy and code have no em or en dashes", () => {
    for (const f of ["src/lib/firstRun.ts", "src/components/call/FirstRunBar.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(DASH);
  });
});
