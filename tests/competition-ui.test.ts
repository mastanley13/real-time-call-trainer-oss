import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPETE_NAV, PRICING_NAV } from "@/components/SiteHeader";
import { clockLabel, competeCta, countdownLabel, entryStatusLabel } from "@/components/compete/CompeteClient";
import { linkedInShareUrl, xShareUrl } from "@/components/compete/ShareCardActions";
import { COMPETITION_OPENING_BOARD_TARGET, COMPETITION_TRACKS, getOpeningBoardState, type CompetitionStatusResponse } from "@/lib/competition";
import { COMPETE_CARD_IMAGE, isPublicPath } from "@/lib/publicPaths";

type Season = CompetitionStatusResponse["season"];
type Viewer = CompetitionStatusResponse["viewer"];

const UI_FILES = [
  "src/app/compete/page.tsx",
  "src/components/compete/CompeteClient.tsx",
  "src/components/landing/LeaderboardSpotlight.tsx",
  "src/app/compete/card/[token]/page.tsx",
  "src/components/compete/ShareCardActions.tsx",
];
const OG_FILE = "src/app/compete/card/[token]/opengraph-image.tsx";
const read = (f: string) => readFileSync(f, "utf8");

const season = (over: Partial<Season> = {}): Season => ({
  slug: "launch-2026", title: "Launch Sales Call Championship", enabled: true, phase: "active", startAt: null, endAt: null,
  maxAttempts: 3, maxCallSeconds: 360, minDurationSeconds: 45, minTraineeTurns: 4, demoMode: false, globalCallsUsed: 0, globalCallsCap: 1500,
  ...over,
});
const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  authenticated: true, displayName: "Sam R.", teamLabel: null, attemptsUsed: 0, attemptsRemaining: 3, bestScore: null, overallRank: null, entries: [],
  ...over,
});
const track = COMPETITION_TRACKS.find((t) => t.slug === "dealerships")!;

describe("championship public paths", () => {
  it.each(["/compete", "/compete/", "/compete?track=dealerships", "/compete#leaderboard", "/api/competition", "/api/competition?track=dealerships", "/api/competition/card/abc_123", "/compete/card/abc_123", "/compete/card/abc_123/", "/compete/card/abc_123/opengraph-image", "/compete/card/abc_123/twitter-image-1a2b3c"])(
    "%s is public",
    (p) => expect(isPublicPath(p)).toBe(true),
  );

  it.each(["/trainer", "/trainer?compete=dealerships", "/compete-admin", "/competition", "/dashboard"])("%s stays behind the gate", (p) => {
    expect(isPublicPath(p)).toBe(false);
  });

  it("matches card images with and without a content hash", () => {
    expect(COMPETE_CARD_IMAGE.test("/compete/card/abc_123/opengraph-image")).toBe(true);
    expect(COMPETE_CARD_IMAGE.test("/compete/card/abc-123/opengraph-image-9f8e7d")).toBe(true);
    expect(COMPETE_CARD_IMAGE.test("/compete/card/abc/123/opengraph-image")).toBe(false);
    expect(COMPETE_CARD_IMAGE.test("/compete/opengraph-image")).toBe(false);
  });
});

describe("header navigation", () => {
  it("links Compete for every visitor, next to Pricing", () => {
    expect(COMPETE_NAV.href).toBe("/compete");
    expect(COMPETE_NAV.label).toBe("Compete");
    expect(COMPETE_NAV.match("/compete")).toBe(true);
    expect(COMPETE_NAV.match("/compete/card/abc")).toBe(true);
    expect(COMPETE_NAV.match("/pricing")).toBe(false);
    const src = read("src/components/SiteHeader.tsx");
    expect(src).toContain("const barLinks = [...(isAuthenticated ? links : []), COMPETE_NAV, PRICING_NAV];");
    expect(src).toContain("{barLinks.map((l) => {");
    expect(src).toContain("items={barLinks.map((l) => ({");
    expect(PRICING_NAV.href).toBe("/pricing");
  });
});

describe("quick brief call to action", () => {
  const cta = (s: Season | null, v: Viewer | null, authenticated = true, loading = false) => competeCta({ track, season: s, viewer: v, authenticated, loading });

  it("starts the next official attempt for a signed-in rep", () => {
    expect(cta(season(), viewer())).toEqual({ kind: "start", href: "/trainer?compete=dealerships", label: "Start official call (Attempt 1 of 3)" });
    expect(cta(season(), viewer({ attemptsUsed: 2, attemptsRemaining: 1 }))).toMatchObject({ label: "Start official call (Attempt 3 of 3)" });
  });

  it("sends guests to register with the track, and offers sign in back to /compete", () => {
    expect(cta(season(), viewer({ authenticated: false }), false)).toEqual({
      kind: "guest",
      registerHref: "/register?src=compete&seg=dealerships",
      loginHref: "/login?next=%2Fcompete",
    });
    // The status call failed: a guest still gets the sign-up path.
    expect(cta(null, null, false)).toMatchObject({ kind: "guest" });
  });

  it("locks the start once all attempts are used", () => {
    expect(cta(season(), viewer({ attemptsUsed: 3, attemptsRemaining: 0 }))).toEqual({ kind: "used", label: "All 3 official attempts used", practiceHref: "/trainer" });
  });

  it("explains closed seasons and a full global cap", () => {
    expect(cta(season({ phase: "ended" }), viewer())).toMatchObject({ kind: "closed", message: expect.stringContaining("has ended") });
    expect(cta(season({ phase: "disabled", enabled: false }), viewer())).toMatchObject({ kind: "closed", message: expect.stringContaining("not open") });
    expect(cta(season({ phase: "upcoming", startAt: "2026-12-01T15:00:00.000Z" }), viewer())).toMatchObject({ kind: "closed", message: expect.stringContaining("December 1") });
    expect(cta(season({ phase: "upcoming" }), null, false)).toMatchObject({ kind: "guest", note: expect.stringContaining("opens soon") });
    expect(cta(season({ globalCallsUsed: 1500 }), viewer())).toMatchObject({ kind: "closed", message: expect.stringContaining("taken") });
  });

  it("waits while loading and reports a failed status for signed-in reps", () => {
    expect(cta(null, null, true, true)).toEqual({ kind: "loading" });
    expect(cta(null, null, true)).toMatchObject({ kind: "unavailable" });
  });
});

describe("countdown badge", () => {
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  it("counts down an active season", () => {
    expect(countdownLabel(season({ endAt: "2026-11-27T15:30:00.000Z" }), now)).toBe("3d 3h left");
    expect(countdownLabel(season({ endAt: "2026-11-24T14:05:00.000Z" }), now)).toBe("2h 5m left");
    expect(countdownLabel(season({ endAt: "2026-11-24T12:00:20.000Z" }), now)).toBe("1m left");
    expect(countdownLabel(season(), now)).toBe("Live now");
  });

  it("labels demo, upcoming, ended and disabled seasons", () => {
    expect(countdownLabel(season({ demoMode: true, endAt: "2026-11-27T15:30:00.000Z" }), now)).toBe("Demo preview");
    expect(countdownLabel(season({ phase: "upcoming", startAt: "2026-11-26T12:00:00.000Z" }), now)).toBe("Opens in 2d 0h");
    expect(countdownLabel(season({ phase: "ended" }), now)).toBe("Season ended");
    expect(countdownLabel(season({ phase: "disabled" }), now)).toBe("Not open yet");
  });

  it("formats the hard timer", () => {
    expect(clockLabel(360)).toBe("6:00");
    expect(clockLabel(45)).toBe("0:45");
  });
});

describe("past attempt status", () => {
  it("names attempts without a ranked score", () => {
    expect(entryStatusLabel({ status: "completed", overallScore: 82 })).toBeNull();
    expect(entryStatusLabel({ status: "completed", overallScore: null })).toBe("Did not qualify");
    expect(entryStatusLabel({ status: "minted", overallScore: null })).toBe("In progress");
    expect(entryStatusLabel({ status: "abandoned", overallScore: null })).toBe("Did not finish");
    expect(entryStatusLabel({ status: "refunded", overallScore: null })).toBe("Not counted");
  });
});

describe("share links", () => {
  const url = "https://calltrainer.tech/compete/card/abc_123";
  it("encodes the card URL and text", () => {
    expect(linkedInShareUrl(url)).toBe("https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fcalltrainer.tech%2Fcompete%2Fcard%2Fabc_123");
    expect(xShareUrl(url, "I scored 89/100 (A) & more")).toBe(
      "https://x.com/intent/tweet?text=I%20scored%2089%2F100%20(A)%20%26%20more&url=https%3A%2F%2Fcalltrainer.tech%2Fcompete%2Fcard%2Fabc_123",
    );
  });
});

describe("opening board gathering state", () => {
  it("shows 5 open spots when no official calls are posted yet", () => {
    const s = getOpeningBoardState(0, "November 2026");
    expect(s.gathering).toBe(true);
    expect(s.filledCount).toBe(0);
    expect(s.targetCount).toBe(COMPETITION_OPENING_BOARD_TARGET);
    expect(s.openRanks).toEqual([1, 2, 3, 4, 5]);
    expect(s.headline).toContain("Gathering opening contenders");
    expect(s.detail).toContain("november 2026");
    expect(s.progressLabel).toBe("0 of 5 spots filled");
  });

  it("fills remaining open ranks between 1 and 4 contenders and names the track when filtered", () => {
    const s0 = getOpeningBoardState(0, "Today", "Car Dealerships");
    expect(s0.detail).toContain("Car Dealerships calls");

    const s3 = getOpeningBoardState(3, "This month");
    expect(s3.gathering).toBe(true);
    expect(s3.openRanks).toEqual([4, 5]);
    expect(s3.headline).toContain("2 spots open");
    expect(s3.detail).toContain("#4");
    expect(s3.progressLabel).toBe("3 of 5 spots filled");

    const s4 = getOpeningBoardState(4, "This month");
    expect(s4.openRanks).toEqual([5]);
    expect(s4.headline).toContain("1 spot open");
  });

  it("switches to pure ranked leaderboard once 5 or more scores exist", () => {
    const s5 = getOpeningBoardState(5, "November 2026");
    expect(s5.gathering).toBe(false);
    expect(s5.openRanks).toEqual([]);
    expect(s5.headline).toBe("");
  });
});

describe("championship UI follows the Flight Deck rules", () => {
  const PALETTE_RE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|shadow|accent|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?\b/;

  it.each(UI_FILES)("%s has no palette classes, color literals or dark: overrides", (f) => {
    const src = read(f);
    expect(src).not.toMatch(PALETTE_RE);
    expect(src).not.toMatch(/\brgba?\(\s*\d/);
    expect(src).not.toMatch(/\bdark:/);
    // "#" only appears in rank text (`#${rank}`, "#1") and anchors (#tracks), never as a hex color.
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it.each([...UI_FILES, OG_FILE, "src/lib/publicPaths.ts", "src/components/SiteHeader.tsx"])("%s has no em dashes", (f) => {
    expect(read(f)).not.toContain("—");
  });

  it("colors the share image from the deck tokens, not literals", () => {
    const src = read(OG_FILE);
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(src).toContain('readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8")');
    expect(src).toContain('import { getCompetitionShareCard } from "@/lib/competitionServer";');
  });

  it("uses the shared share-card loader on the card page and image", () => {
    expect(read("src/app/compete/card/[token]/page.tsx")).toContain('import { getCompetitionShareCard } from "@/lib/competitionServer";');
  });
});
