import { PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT } from "./pricing";

/**
 * Shared client-safe contract for the 30-day Launch Sales Call Championship (/compete).
 * Pure constants, types, track definitions, and validation helpers only. No secrets or DB code.
 */

export const COMPETITION_MAX_ATTEMPTS = 3;
export const COMPETITION_CALL_MAX_SECONDS = 360; // 6 minutes hard cap
export const COMPETITION_MIN_DURATION_SECONDS = 45;
export const COMPETITION_MIN_TRAINEE_TURNS = 4;
export const COMPETITION_DEFAULT_SEASON = "launch-2026";
export const COMPETITION_DEFAULT_TITLE = "Sales Call Championship";
export const COMPETITION_DEFAULT_MAX_TOTAL_CALLS = 1500;

export const COMPETITION_PERIODS = ["day", "week", "month", "year"] as const;
export type CompetitionPeriod = (typeof COMPETITION_PERIODS)[number];

export const COMPETITION_PERIOD_LABELS: Record<CompetitionPeriod, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
};

export function isCompetitionPeriod(value: unknown): value is CompetitionPeriod {
  return typeof value === "string" && (COMPETITION_PERIODS as readonly string[]).includes(value);
}

/** Auto-rolling UTC calendar-month season key, e.g. "2026-11". */
export function calendarSeasonSlug(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Half-open UTC calendar bounds [start, end) and human label for day, week (Mon-Sun), month, or year. */
export function competitionPeriodBounds(period: CompetitionPeriod, now = new Date()): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "day") {
    const start = new Date(Date.UTC(y, m, d));
    const end = new Date(Date.UTC(y, m, d + 1));
    return { start, end, label: "Today" };
  }
  if (period === "week") {
    const weekday = (now.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
    const start = new Date(Date.UTC(y, m, d - weekday));
    const end = new Date(Date.UTC(y, m, d - weekday + 7));
    return { start, end, label: "This week" };
  }
  if (period === "year") {
    const start = new Date(Date.UTC(y, 0, 1));
    const end = new Date(Date.UTC(y + 1, 0, 1));
    return { start, end, label: String(y) };
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { start, end, label };
}

export const COMPETITION_TRACK_SLUGS = [
  "home-services",
  "insurance",
  "solar",
  "dealerships",
  "saas-sdr",
  "real-estate",
  "price-objection",
] as const;

export type CompetitionTrackSlug = (typeof COMPETITION_TRACK_SLUGS)[number];

export interface CompetitionRoleCard {
  /** Who the rep is playing on this call, e.g. "Account Executive · Operations Software". */
  yourRole: string;
  /** The exact offer, price, or proposal on the table in one crisp line. */
  pitching: string;
  /** How this call starts — only what a real rep knows before dialing (no hidden spoilers). */
  situation: string;
  /** Exact opening line the buyer speaks when the call connects. */
  openingLine: string;
}

export interface CompetitionTrack {
  slug: CompetitionTrackSlug;
  label: string;
  shortLabel: string;
  scenarioId: string;
  buyerName: string;
  difficulty: "easy" | "medium" | "hard";
  callTypeLabel: string;
  shortPitch: string;
  roleCard: CompetitionRoleCard;
  quickBriefGoal: string;
  watchOuts: readonly [string, string];
}

/**
 * Seven standardized competition tracks mapped to canonical built-in LIBRARY scenarios.
 * The server always loads the canonical scenario from LIBRARY by scenarioId so clients cannot
 * tamper with the buyer prompt or grading rubric.
 */
export const COMPETITION_TRACKS: readonly CompetitionTrack[] = [
  {
    slug: "home-services",
    label: "Home Services",
    shortLabel: "Home Services",
    scenarioId: "quote-follow-up",
    buyerName: "Marcus Bell",
    difficulty: "medium",
    callTypeLabel: "Quote follow-up",
    shortPitch: "$14,800 roof replacement quote gone quiet after your inspection last week.",
    roleCard: {
      yourRole: "Roofing Estimator",
      pitching: "$14,800 full roof replacement (full tear-off + 25-year material warranty)",
      situation: "You inspected Marcus's roof last week and emailed the $14,800 quote. He went quiet, so you are calling to follow up.",
      openingLine: "Oh hey, yeah, I got the quote. I've just been really busy, honestly.",
    },
    quickBriefGoal: "Uncover what is holding him back, reinforce warranty and crew value without immediate discounting, and lock a dated next step.",
    watchOuts: [
      "He will not volunteer his real hesitation unless you ask calm, open questions.",
      "Dropping your price immediately or pushing past family concerns costs points.",
    ],
  },
  {
    slug: "insurance",
    label: "Insurance",
    shortLabel: "Insurance",
    scenarioId: "insurance-renewal-premium-jump",
    buyerName: "Imani Brooks",
    difficulty: "medium",
    callTypeLabel: "Renewal retention",
    shortPitch: "Nine-year homeowner calling in upset over a 41% renewal jump ($1,640 to $2,310).",
    roleCard: {
      yourRole: "Licensed Insurance Agent",
      pitching: "Homeowners policy renewal ($2,310/yr, up from $1,640/yr · $1,000 deductible · due on the 15th)",
      situation: "Imani has insured her home with your agency for 9 years. She just opened her renewal notice and called in asking if the 41% increase is a mistake.",
      openingLine: "Hi, I just got my renewal notice and my premium jumped from sixteen-forty to twenty-three ten. Is that a mistake?",
    },
    quickBriefGoal: "Acknowledge the jump first, break down the real rating drivers, review deductible and coverage trade-offs honestly, and book a dated comparison call.",
    watchOuts: [
      "Never promise a lower rate, rate match, or guaranteed approval, and never cut dwelling coverage below rebuild cost.",
      "If she mentions another quote, ask what deductible and roof terms it covers before reacting.",
    ],
  },
  {
    slug: "solar",
    label: "Solar",
    shortLabel: "Solar",
    scenarioId: "solar-burned-homeowner-discovery",
    buyerName: "Odalys Kruger",
    difficulty: "hard",
    callTypeLabel: "Skeptical discovery",
    shortPitch: "Homeowner burned by a past 'free solar' pitch whose original installer shut down.",
    roleCard: {
      yourRole: "Solar Diagnostics Specialist",
      pitching: "$149 written, no-obligation system and warranty review (not a new panel pitch)",
      situation: "A neighbor passed Odalys's number to your company. She already has solar from a closed installer and expects you to launch into another sales pitch.",
      openingLine: "Okay, I'll be blunt. My neighbor said you'd be calling, and if this is another free solar pitch, I'm hanging up.",
    },
    quickBriefGoal: "De-escalate without pitching, gather her system and loan facts, answer guarantee and tax-credit questions honestly, and book a priced written review.",
    watchOuts: [
      "Never say solar is free or guarantee savings or tax credits; explain a tax credit lowers tax owed and depends on her tax situation.",
      "State the $149 review fee plainly and explain what you can and cannot check.",
    ],
  },
  {
    slug: "dealerships",
    label: "Car Dealerships",
    shortLabel: "Dealerships",
    scenarioId: "auto-pickup-negotiation-rival-quote",
    buyerName: "Ingrid Solberg",
    difficulty: "medium",
    callTypeLabel: "Vehicle negotiation",
    shortPitch: "$38,400 pickup shopper calling back after Saturday's test drive to review the numbers.",
    roleCard: {
      yourRole: "Automotive Sales Specialist",
      pitching: "2022 midsize pickup ($38,400 list, tow package) · $9,200 appraisal on her 2017 sedan",
      situation: "Ingrid test-drove the pickup Saturday and liked it. She is calling back to go over the vehicle price, trade value, and financing before deciding.",
      openingLine: "Hi, it's Ingrid. I drove the truck on Saturday and I liked it, but I need to understand the numbers before I decide anything.",
    },
    quickBriefGoal: "Discover her priorities, explain the trade appraisal transparently, compare price, miles, and tow package line by line, and close on written numbers.",
    watchOuts: [
      "Never use false urgency, payment-only steering, or claim an extended warranty is required for financing.",
      "Itemize price, trade, taxes, fees, and financing terms clearly; rates depend on lender approval.",
    ],
  },
  {
    slug: "saas-sdr",
    label: "B2B SaaS / SDR",
    shortLabel: "B2B SaaS",
    scenarioId: "sdr-busy-ops-vp-freight-broker",
    buyerName: "Gabriela Ostrowski",
    difficulty: "hard",
    callTypeLabel: "Cold call",
    shortPitch: "Busy VP of Operations at a 40-person freight brokerage giving cold callers 20 seconds.",
    roleCard: {
      yourRole: "Outbound SDR · Freight Visibility Software",
      pitching: "Real-time load tracking and late-pickup alert software (goal: book a 15-minute intro)",
      situation: "You are cold-calling the VP of Operations at Ketterhill Freight Partners (40-person brokerage). She answers her own direct line between carrier calls.",
      openingLine: "Ketterhill, this is Gabi.",
    },
    quickBriefGoal: "Earn 30 seconds with a researched opener, uncover how late-pickup exceptions hurt her dispatchers, handle brush-offs calmly, and book a 15-minute slot.",
    watchOuts: [
      "Skip generic 'how are you' small talk or feature dumps; she cuts off long pitches fast.",
      "Meet 'we already have a TMS' and 'send me an email' with calm curiosity instead of arguing.",
    ],
  },
  {
    slug: "real-estate",
    label: "Real Estate",
    shortLabel: "Real Estate",
    scenarioId: "real-estate-expired-listing-cold-call",
    buyerName: "Yusuf Demir",
    difficulty: "hard",
    callTypeLabel: "Expired listing",
    shortPitch: "Frustrated homeowner whose $389,000 listing expired yesterday after 94 days.",
    roleCard: {
      yourRole: "Residential Listing Agent",
      pitching: "No-obligation in-person pricing review and written weekly communication plan",
      situation: "Yusuf's listing at 905 Sycamore Way ($389,000) expired yesterday after 94 days on market. You are cold-calling to see if he is still open to selling.",
      openingLine: "Hello? Who is this? If you're another real estate agent, I'm really not interested.",
    },
    quickBriefGoal: "Ask permission, confirm no active listing, uncover why it sat unsold, differentiate with a written communication plan, and earn a no-obligation visit.",
    watchOuts: [
      "Never disparage the previous agent or guarantee a sale price or timeline.",
      "If he asks to stop calling, honor it immediately and confirm removal.",
    ],
  },
  {
    slug: "price-objection",
    label: "Open Price Objection",
    shortLabel: "Price Objection",
    scenarioId: "objection-handling",
    buyerName: "Priya Raman",
    difficulty: "hard",
    callTypeLabel: "Price negotiation",
    shortPitch: "Operations manager pushing back on your $1,200/mo software proposal and 24-month term.",
    roleCard: {
      yourRole: "Account Executive · Operations Software",
      pitching: "$1,200/mo operations workflow & reporting suite (24-mo plan · 90-day pilot available)",
      situation: "You sent Priya a $1,200/mo proposal for her 35-person ops team. She just picked up your follow-up call ready to challenge the price.",
      openingLine: "I'll be straight with you: this is twice what we pay now. I don't see how it's worth it.",
    },
    quickBriefGoal: "Validate without getting defensive, clarify what she compares against, reframe on concrete outcomes, solve the contract blocker, and ask for a commitment.",
    watchOuts: [
      "Do not defend the price or drop into a vague feature list before clarifying her current baseline.",
      "Expect a second objection on the 24-month contract once you handle price; a 90-day month-to-month pilot is on the table.",
    ],
  },
] as const;

export const COMPETITION_PRIZES = {
  soloHeadline: "1 full year of Pro free",
  soloValueUsd: PRICE.pro.year,
  soloDetail: `Monthly #1 finisher wins 1 year of Pro ($${PRICE.pro.year} value, ${PRO_VOICE_MIN} Standard voice minutes every month).`,
  teamHeadline: "Team winner bonus: 1st seat free + 50% off every extra seat for 1 year",
  teamRegularSeatYearUsd: PRICE.team.year,
  teamDiscountSeatYearUsd: Math.round(PRICE.team.year / 2),
  teamDetail: `If the monthly winner or someone on their team activates Team (${TEAM_MIN_SEATS} seats min), their first seat is free for a full year and every additional seat is 50% off ($${Math.round(PRICE.team.year / 2)}/seat/yr instead of $${PRICE.team.year}/seat/yr, ${TEAM_VOICE_MIN_PER_SEAT} pooled minutes per seat monthly).`,
} as const;

export type CompetitionPhase = "disabled" | "upcoming" | "active" | "ended";

export type CompetitionEntryStatus = "minted" | "completed" | "abandoned" | "refunded";

export interface CompetitionSeasonInfo {
  slug: string;
  title: string;
  enabled: boolean;
  phase: CompetitionPhase;
  startAt: string | null;
  endAt: string | null;
  maxAttempts: number;
  maxCallSeconds: number;
  minDurationSeconds: number;
  minTraineeTurns: number;
  demoMode: boolean;
  globalCallsUsed: number;
  globalCallsCap: number;
}

export interface CompetitionLeaderboardRow {
  rank: number;
  entryId: string;
  displayName: string;
  teamLabel: string | null;
  trackSlug: CompetitionTrackSlug;
  trackLabel: string;
  overallScore: number;
  grade: string;
  goalAchieved: boolean;
  completedAt: string;
  shareToken: string;
  isCurrentUser: boolean;
}

export interface CompetitionUserEntry {
  id: string;
  attemptNumber: number;
  trackSlug: CompetitionTrackSlug;
  trackLabel: string;
  scenarioId: string;
  status: CompetitionEntryStatus;
  overallScore: number | null;
  grade: string | null;
  goalAchieved: boolean | null;
  durationSeconds: number;
  shareToken: string;
  trainerSessionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CompetitionViewerState {
  authenticated: boolean;
  displayName: string | null;
  teamLabel: string | null;
  attemptsUsed: number;
  attemptsRemaining: number;
  bestScore: number | null;
  overallRank: number | null;
  entries: CompetitionUserEntry[];
}

export interface CompetitionStatusResponse {
  season: CompetitionSeasonInfo;
  period: CompetitionPeriod;
  periodLabel: string;
  tracks: readonly CompetitionTrack[];
  leaderboard: CompetitionLeaderboardRow[];
  totalQualifiedEntries: number;
  viewer: CompetitionViewerState;
}

export interface CompetitionShareCardData {
  shareToken: string;
  seasonSlug: string;
  seasonTitle: string;
  displayName: string;
  teamLabel: string | null;
  trackSlug: CompetitionTrackSlug;
  trackLabel: string;
  buyerName: string;
  overallScore: number;
  grade: string;
  goalAchieved: boolean;
  overallRank: number;
  industryRank: number;
  totalEntries: number;
  completedAt: string;
  demoMode: boolean;
}

export interface CompetitionFinalizeResult {
  entryId: string;
  attemptNumber: number;
  trackSlug: CompetitionTrackSlug;
  trackLabel: string;
  qualified: boolean;
  reason?: CompetitionDisqualifyReason;
  message?: string;
  overallScore: number | null;
  grade: string | null;
  overallRank: number | null;
  industryRank: number | null;
  shareToken: string;
}

export type CompetitionDisqualifyReason = "not_ai_graded" | "too_short" | "too_few_turns" | "missing_score";

export type CompetitionValidityResult =
  | { qualified: true }
  | { qualified: false; reason: CompetitionDisqualifyReason; message: string };

export function isCompetitionTrackSlug(value: unknown): value is CompetitionTrackSlug {
  return typeof value === "string" && (COMPETITION_TRACK_SLUGS as readonly string[]).includes(value);
}

export function competitionTrackBySlug(slug: string | null | undefined): CompetitionTrack | undefined {
  if (!slug) return undefined;
  return COMPETITION_TRACKS.find((t) => t.slug === slug);
}

export function competitionTrackByScenarioId(scenarioId: string | null | undefined): CompetitionTrack | undefined {
  if (!scenarioId) return undefined;
  return COMPETITION_TRACKS.find((t) => t.scenarioId === scenarioId);
}

/** Determine whether a competition season is disabled, upcoming, active, or ended. */
export function competitionPhase(
  cfg: { enabled: boolean; startAt: Date | null; endAt: Date | null },
  now = new Date(),
): CompetitionPhase {
  if (!cfg.enabled) return "disabled";
  const t = now.getTime();
  if (cfg.startAt && t < cfg.startAt.getTime()) return "upcoming";
  if (cfg.endAt && t >= cfg.endAt.getTime()) return "ended";
  return "active";
}

/** Count trainee ("user") turns that contain non-empty speech. */
export function countTraineeTurns(transcript: ReadonlyArray<{ role: string; text: string }>): number {
  let count = 0;
  for (const turn of transcript) {
    if (turn.role === "user" && turn.text.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Pure qualification gate for official leaderboard entries:
 * - Must be AI-graded (method === "llm") with a valid numeric score
 * - Must last at least 45 seconds
 * - Must have at least 4 non-empty trainee turns
 */
export function validateCompetitionSubmission(input: {
  durationSeconds: number;
  transcript: ReadonlyArray<{ role: string; text: string }>;
  method?: string | null;
  overallScore?: number | null;
}): CompetitionValidityResult {
  if (input.method !== "llm") {
    return {
      qualified: false,
      reason: "not_ai_graded",
      message: "Official competition scores require live AI grading. Heuristic fallback scores are not ranked.",
    };
  }
  if (typeof input.overallScore !== "number" || !Number.isFinite(input.overallScore)) {
    return {
      qualified: false,
      reason: "missing_score",
      message: "This call did not produce a verified AI score.",
    };
  }
  if (input.durationSeconds < COMPETITION_MIN_DURATION_SECONDS) {
    return {
      qualified: false,
      reason: "too_short",
      message: `Official calls must last at least ${COMPETITION_MIN_DURATION_SECONDS} seconds to rank on the leaderboard.`,
    };
  }
  if (countTraineeTurns(input.transcript) < COMPETITION_MIN_TRAINEE_TURNS) {
    return {
      qualified: false,
      reason: "too_few_turns",
      message: `Official calls need at least ${COMPETITION_MIN_TRAINEE_TURNS} spoken rep turns to qualify.`,
    };
  }
  return { qualified: true };
}

/** Strip control chars, collapse whitespace, and cap length for public leaderboard display names. */
export function sanitizeDisplayName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40);
}

/** Optional public team/company label for the leaderboard. */
export function sanitizeTeamLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 48) : null;
}

/** Privacy-safe default display name so raw email addresses are never shown publicly. */
export function defaultDisplayName(user: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const first = sanitizeDisplayName(user.firstName ?? "");
  const last = sanitizeDisplayName(user.lastName ?? "");
  if (first && last) return sanitizeDisplayName(`${first} ${last[0].toUpperCase()}.`);
  if (first) return first;
  if (user.email) {
    const local = user.email.split("@")[0]?.replace(/[^a-zA-Z0-9._-]/g, " ") ?? "";
    const cleaned = sanitizeDisplayName(local);
    if (cleaned) return cleaned.slice(0, 20);
  }
  return "Competitor";
}

/**
 * Deterministic leaderboard comparator:
 * 1. Higher overallScore first
 * 2. goalAchieved true before false
 * 3. Earlier completedAt wins ties (first to post the score holds the higher rank)
 */
export function compareLeaderboardRows<
  T extends { overallScore: number; goalAchieved: boolean; completedAt: string | Date },
>(a: T, b: T): number {
  if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
  if (a.goalAchieved !== b.goalAchieved) return a.goalAchieved ? -1 : 1;
  const aMs = typeof a.completedAt === "string" ? Date.parse(a.completedAt) : a.completedAt.getTime();
  const bMs = typeof b.completedAt === "string" ? Date.parse(b.completedAt) : b.completedAt.getTime();
  return aMs - bMs;
}

/**
 * Opening-board threshold. While fewer than this many official scores exist in a window,
 * the leaderboard shows an explicit "gathering opening contenders" banner and open podium
 * slots so a fresh board reads as an active early round rather than a broken empty table.
 */
export const COMPETITION_OPENING_BOARD_TARGET = 5;

export interface OpeningBoardState {
  gathering: boolean;
  filledCount: number;
  targetCount: number;
  openRanks: number[];
  headline: string;
  detail: string;
  progressLabel: string;
}

export function getOpeningBoardState(
  rowCount: number,
  periodLabel: string,
  trackLabel?: string | null,
): OpeningBoardState {
  const targetCount = COMPETITION_OPENING_BOARD_TARGET;
  const filledCount = Math.max(0, Math.floor(rowCount));
  if (filledCount >= targetCount) {
    return {
      gathering: false,
      filledCount,
      targetCount,
      openRanks: [],
      headline: "",
      detail: "",
      progressLabel: "",
    };
  }
  const openCount = targetCount - filledCount;
  const openRanks = Array.from({ length: openCount }, (_, i) => filledCount + i + 1);
  const scope = trackLabel ? `${trackLabel} calls` : "official calls";
  const windowText = periodLabel.toLowerCase();

  if (filledCount === 0) {
    return {
      gathering: true,
      filledCount,
      targetCount,
      openRanks,
      headline: "Gathering opening contenders",
      detail: `No ${scope} posted for ${windowText} yet. The first ${targetCount} scores fill the opening board.`,
      progressLabel: `0 of ${targetCount} spots filled`,
    };
  }

  return {
    gathering: true,
    filledCount,
    targetCount,
    openRanks,
    headline: `Gathering opening contenders (${openCount} ${openCount === 1 ? "spot" : "spots"} open)`,
    detail: `Early rounds are underway for ${windowText}. Post a verified call to claim #${filledCount + 1} or pass the leaders.`,
    progressLabel: `${filledCount} of ${targetCount} spots filled`,
  };
}
