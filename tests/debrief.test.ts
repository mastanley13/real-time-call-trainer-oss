import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_SESSION_CAP, TRANSCRIPT_LIST_CAP, nextDrill, retryPoint, showFirstGradedDemo, viewerOwnsSession } from "@/lib/debrief";
import { readLocalSessionsStrict } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import { LIBRARY } from "@/lib/personas";
import { BUILT_IN_SCENARIOS, type ObjectionType, type Scenario } from "@/lib/scenarios";

const base = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;

const evaluation = (criteria: { id: string; name: string; score: number; line?: number }[]): Evaluation => ({
  method: "heuristic",
  overallScore: 50,
  grade: "F",
  summary: "",
  criteria: criteria.map((c) => ({ id: c.id, name: c.name, weight: 1, score: c.score, rationale: "", evidence: c.line ? [{ speaker: "trainee", quote: "x", line: c.line }] : [] })),
  strengths: [],
  improvements: [],
  goalAchievement: { achieved: false, explanation: "" },
});

describe("retryPoint", () => {
  const transcript = [
    { role: "assistant", text: "Hi, my water heater is leaking. Can someone come out today?" },
    { role: "user", text: "Thanks for calling, this is Sam. Our price is fair, don't worry." },
    { role: "assistant", text: "It started this morning." },
    { role: "user", text: "How old is the unit?" },
    { role: "assistant", text: "About eleven years. What does a visit cost?" },
    { role: "user", text: "We can come at 3 pm." },
    { role: "assistant", text: "Fine." },
  ];

  it("restarts at the persona line that raises the weakest topic", () => {
    const ev = evaluation([
      { id: "greeting", name: "Greeting & rapport", score: 90 },
      { id: "fee", name: "Pricing transparency", score: 30 },
      { id: "close", name: "Booking & next steps", score: 70 },
    ]);
    // The rep's own "price" line (T2) is skipped; the persona's cost question is T5.
    expect(retryPoint(transcript, ev)).toEqual({ turn: 5, criterion: "Pricing transparency", score: 30 });
  });

  it("never picks the opening line, and falls back to the persona line before the weakest evidence", () => {
    const opensOnPrice = [{ role: "assistant", text: "How much does a visit cost?" }, ...transcript.slice(1, 4)];
    const ev = evaluation([{ id: "fee", name: "Pricing transparency", score: 20, line: 4 }, { id: "greeting", name: "Greeting", score: 80 }]);
    expect(retryPoint(opensOnPrice, ev)?.turn).toBe(3);
  });

  it("returns null with nothing to retry", () => {
    expect(retryPoint(transcript, evaluation([]))).toBeNull();
    expect(retryPoint(transcript.slice(0, 1), evaluation([{ id: "fee", name: "Pricing", score: 10 }]))).toBeNull();
  });
});

describe("nextDrill", () => {
  const persona = (id: string, role: string, type: ObjectionType): Scenario => ({ ...base, id, role, objections: [{ type, line: "An objection.", prepAnswer: "" }] });

  it("drills the weakest topic's objection type with a different library persona", () => {
    const drill = nextDrill(LIBRARY, { id: base.id, role: base.role }, "Pricing transparency");
    expect(drill).toBeDefined();
    expect(drill!.id).not.toBe(base.id);
    expect(drill!.objections.some((o) => o.type === "price")).toBe(true);
    const sameRoleExists = LIBRARY.some((s) => s.id !== base.id && s.role === base.role && s.objections.some((o) => o.type === "price"));
    if (sameRoleExists) expect(drill!.role).toBe(base.role);
  });

  it("prefers a matching objection over a matching role", () => {
    const current = persona("current", "solar", "price");
    const lib = [current, persona("same-role-timing", "solar", "timing"), persona("other-role-price", "auto", "price")];
    expect(nextDrill(lib, current, "Pricing transparency")?.id).toBe("other-role-price");
    expect(nextDrill(lib, current, "Competitor comparison")?.id).toBe("same-role-timing");
  });

  it("never returns the current persona, even when it is the only match", () => {
    const current = persona("current", "solar", "price");
    expect(nextDrill([current, persona("x", "auto", "trust")], current, "Fee explanation")?.id).toBe("x");
    expect(nextDrill([current], current, "Fee explanation")).toBeUndefined();
  });
});

describe("showFirstGradedDemo", () => {
  it("shows on the first graded call, whether or not the list includes it", () => {
    expect(showFirstGradedDemo("local-a", true, [{ id: "local-a", graded: true }])).toBe(true);
    expect(showFirstGradedDemo("s-1", true, [])).toBe(true);
    expect(showFirstGradedDemo("s-1", true, [{ id: "s-1", graded: true }, { id: "s-0", graded: false }])).toBe(true);
  });

  it("hides once another session has a grade", () => {
    expect(showFirstGradedDemo("s-2", true, [{ id: "s-2", graded: true }, { id: "s-1", graded: true }])).toBe(false);
    expect(showFirstGradedDemo("s-2", true, [{ id: "s-1", graded: true }])).toBe(false);
  });

  it("hides when this call has no grade", () => {
    expect(showFirstGradedDemo("s-1", false, [])).toBe(false);
    expect(showFirstGradedDemo("s-1", false, [{ id: "s-1", graded: false }])).toBe(false);
  });

  const many = (n: number, gradedId?: string) => Array.from({ length: n }, (_, i) => ({ id: `s-${i}`, graded: `s-${i}` === gradedId }));

  it("a list at the API cap with no other grade may be cut off, so it hides", () => {
    expect(TRANSCRIPT_LIST_CAP).toBe(100);
    // 100 newest, all ungraded except this call: an older graded call may exist beyond the cap.
    expect(showFirstGradedDemo("s-0", true, many(100, "s-0"), TRANSCRIPT_LIST_CAP)).toBe(false);
    expect(showFirstGradedDemo("s-new", true, many(100), TRANSCRIPT_LIST_CAP)).toBe(false);
    expect(showFirstGradedDemo("s-new", true, many(150), TRANSCRIPT_LIST_CAP)).toBe(false);
  });

  it("a list shorter than the cap is complete, so the usual rule stands", () => {
    expect(showFirstGradedDemo("s-0", true, many(99, "s-0"), TRANSCRIPT_LIST_CAP)).toBe(true);
    expect(showFirstGradedDemo("s-new", true, [], TRANSCRIPT_LIST_CAP)).toBe(true);
    expect(showFirstGradedDemo("s-new", true, many(99, "s-5"), TRANSCRIPT_LIST_CAP)).toBe(false);
    expect(showFirstGradedDemo("s-new", true, many(100, "s-5"), TRANSCRIPT_LIST_CAP)).toBe(false);
  });

  it("applies the browser cap the same way", () => {
    expect(LOCAL_SESSION_CAP).toBe(50);
    expect(showFirstGradedDemo("s-0", true, many(50, "s-0"), LOCAL_SESSION_CAP)).toBe(false);
    expect(showFirstGradedDemo("s-0", true, many(49, "s-0"), LOCAL_SESSION_CAP)).toBe(true);
  });

  it("the page adds the button beside Practice again, only with a grade and a spoken transcript", () => {
    const src = readFileSync("src/app/trainer/debrief/[sessionId]/page.tsx", "utf8");
    expect(src).toContain('{ev && spoke && firstGraded && <a href="/demo" className="btn-ghost">');
    expect(src).toContain("Book a demo for your team</a>}");
    expect(src.indexOf("Book a demo for your team")).toBeGreaterThan(src.indexOf("Practice again</Link>"));
  });

  it("the page uses the strict local reader and passes each list's cap", () => {
    const src = readFileSync("src/app/trainer/debrief/[sessionId]/page.tsx", "utf8");
    expect(src).toContain("const local = readLocalSessionsStrict();");
    expect(src).toContain("if (local) setSessionGrades(");
    expect(src).not.toContain("listLocalSessions()");
    expect(src).toContain("cap: LOCAL_SESSION_CAP");
    expect(src).toContain("cap: TRANSCRIPT_LIST_CAP");
    expect(src).toContain("showFirstGradedDemo(sessionId, !!ev && !isLlmFailedGrade(ev), sessionGrades.sessions, sessionGrades.cap)");
  });
});

describe("viewerOwnsSession", () => {
  it("browser sessions belong to the viewer's own storage", () => {
    expect(viewerOwnsSession({ local: true }, undefined)).toBe(true);
    expect(viewerOwnsSession({ local: true }, "u-1")).toBe(true);
  });

  it("a server session counts only for the trainee who made it", () => {
    expect(viewerOwnsSession({ local: false, ownerId: "u-1" }, "u-1")).toBe(true);
    // A manager or admin opening a trainee's debrief.
    expect(viewerOwnsSession({ local: false, ownerId: "u-1" }, "mgr-9")).toBe(false);
  });

  it("an unknown owner or viewer never counts", () => {
    expect(viewerOwnsSession({ local: false }, "u-1")).toBe(false);
    expect(viewerOwnsSession({ local: false, ownerId: null }, "u-1")).toBe(false);
    expect(viewerOwnsSession({ local: false, ownerId: "u-1" }, undefined)).toBe(false);
    expect(viewerOwnsSession({ local: false, ownerId: "" }, "")).toBe(false);
  });

  it("the page gates the button and the list fetch on ownership", () => {
    const src = readFileSync("src/app/trainer/debrief/[sessionId]/page.tsx", "utf8");
    expect(src).toContain("const ownsView = view ? viewerOwnsSession(view, user?.id) : false;");
    expect(src).toContain("if (viewLocal === null || !ownsView) return;");
    expect(src).toContain("const firstGraded = ownsView && sessionGrades !== null && showFirstGradedDemo(");
    // The ownership check runs before the viewer's list is fetched.
    expect(src.indexOf("if (viewLocal === null || !ownsView) return;")).toBeLessThan(src.indexOf('fetch("/api/transcripts")'));
  });
});

describe("readLocalSessionsStrict", () => {
  const store = (value: string | null) => ({ getItem: (k: string) => (k === "rtct.sessions.v1" ? value : null) });

  it("returns the stored sessions, and [] when nothing is stored yet", () => {
    const s = [{ id: "local-a", evaluation: null }, { id: "local-b", evaluation: { overallScore: 70 } }];
    expect(readLocalSessionsStrict(store(JSON.stringify(s)))).toEqual(s);
    expect(readLocalSessionsStrict(store(null))).toEqual([]);
    expect(readLocalSessionsStrict(store("[]"))).toEqual([]);
  });

  it.each(["{not json", "{}", '"text"', "42", "null", "[1,2]", '[{"id":"a"},null]'])("returns null for stored value %s", (v) => {
    expect(readLocalSessionsStrict(store(v))).toBeNull();
  });

  it("returns null when storage throws or is missing", () => {
    expect(readLocalSessionsStrict({ getItem: () => { throw new Error("SecurityError"); } })).toBeNull();
    // Node has no usable localStorage here unless a test defines one; reading it must not throw.
    const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      expect(readLocalSessionsStrict()).toBeNull();
    } finally {
      if (prev) Object.defineProperty(globalThis, "localStorage", prev);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("leaves listLocalSessions' forgiving behaviour alone for its other callers", () => {
    const src = readFileSync("src/lib/sessionStore.ts", "utf8");
    expect(src).toContain("return Array.isArray(raw) ? raw : [];");
    expect(src).toContain("return readLocal().sort((a, b) => b.createdAt.localeCompare(a.createdAt));");
  });
});
