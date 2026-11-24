/**
 * GPT-Live casting sheet for every library persona: the official Live voice, the delivery notes, and the demographics
 * the persona's own text states. One place to review the whole cast; the library applies it when it loads
 * (src/lib/personas/index.ts), and tests/live-casting.test.ts fails on a persona with no line here.
 * The full table, with uncertainties, is in jobs/personas/persona-voices.md.
 *
 * How a line is cast (a casting choice, never a claim about who the person is):
 * - `gender` is set when the persona's own text states it: a pronoun for the persona in its role, call script, rubric or
 *   goal (he, his, she, her), or a first-person relationship line ("my wife"). `age` is set only when a number is
 *   stated. Nothing is inferred from a name. Six personas never state a gender (listed in UNSPECIFIED below): they are
 *   cast marin, the documented default voice, and the instructions say their gender is unspecified.
 * - A stated woman is cast gleam (younger, brighter) or marin (older, warmer or more senior), both spread across the
 *   library. A stated man is cast meridian or cedar (cedar for older or deeper-sounding characters). These are all
 *   North American voices; no persona states an accent or region, so the Southern US, Australian, British and Irish
 *   voices are not used.
 * - Voice age is not guaranteed by the API: every line spells out maturity, pace and emotional tone in words.
 * - Nothing here has been auditioned. The delivery lines paraphrase each persona's role and behavior.
 * GPT-Live stays off unless OPENAI_VOICE_API=live; the Realtime path never reads this sheet.
 */
import type { Scenario } from "./scenarios";
import type { LiveCastVoice } from "./liveCasting";

export interface LiveCastLine {
  voice: LiveCastVoice;
  delivery: string;
  emotion: string;
  /** Only when the persona's own text states it. */
  gender?: "female" | "male";
  /** Only when the persona's own text states a number. */
  age?: number;
}

type Who = { gender?: "female" | "male"; age?: number };
const line = (voice: LiveCastVoice, who: Who, emotion: string, delivery: string): LiveCastLine => ({ voice, emotion, delivery, ...who });
/** Stated woman, gleam: younger, brighter. */
const G = (emotion: string, delivery: string, age?: number): LiveCastLine => line("gleam", { gender: "female", ...(age === undefined ? {} : { age }) }, emotion, delivery);
/** Stated woman, marin: older, warmer or more senior. */
const MA = (emotion: string, delivery: string, age?: number): LiveCastLine => line("marin", { gender: "female", ...(age === undefined ? {} : { age }) }, emotion, delivery);
/** Stated man, meridian. */
const M = (emotion: string, delivery: string, age?: number): LiveCastLine => line("meridian", { gender: "male", ...(age === undefined ? {} : { age }) }, emotion, delivery);
/** Stated man, cedar: older or deeper-sounding. */
const C = (emotion: string, delivery: string, age?: number): LiveCastLine => line("cedar", { gender: "male", ...(age === undefined ? {} : { age }) }, emotion, delivery);
/** No gender stated anywhere in the persona's text: marin, the default voice. */
const U = (emotion: string, delivery: string, age?: number): LiveCastLine => line("marin", age === undefined ? {} : { age }, emotion, delivery);

export const LIVE_CASTING: Record<string, LiveCastLine> = {
  // ---- built-in examples ----
  "home-services-inbound-lead": U("worried", "Worried but cooperative homeowner: a little quick and anxious at first, steadier once the agent stays calm and gives a clear window; hesitates audibly when the fee comes up."),
  "quote-follow-up": C("noncommittal", "Polite but noncommittal: friendly, easygoing pace, vague and a little evasive about the holdup; opens up only to good open questions."),
  "objection-handling": U("time-pressed", "Direct and time-pressed: brisk and clipped, interrupts vague pitches; softens when the concern is acknowledged."),
  // ---- SDR ----
  "sdr-referral-clinic-ops": MA("curious", "Warm and curious clinic operations director, unhurried and friendly; turns guarded and shorter if the rep skips the referral or reads a script."),
  "sdr-gatekeeper-cfo-assistant": U("guarded", "Polite, firm gatekeeper: even, professional and a little guarded; the default is to take a message, and warmth comes only for a specific, relevant reason."),
  "sdr-busy-ops-vp-freight-broker": G("rushed", "Busy executive answering between carrier calls: fast, clipped and a little distracted, with little patience for fluff."),
  // ---- AE ----
  "ae-agency-owner-inbound-demo": G("stretched", "Agency founder stretched thin after a rough month, who asked for the demo after a client caught an error: friendly, open and a little frazzled; wants concrete answers."),
  "ae-it-director-credit-union": MA("measured", "Thoughtful, measured IT director under audit pressure: careful and precise, opens up only to specific questions, asks pointed security questions at an even pace."),
  "ae-cfo-incumbent-contract": MA("skeptical", "Senior CFO on the call as a favor: dry, brisk and impatient with discovery theater and buzzwords; warms only when the rep is specific and respects the time."),
  // ---- customer success ----
  "cs-at-risk-renewal-low-adoption": G("skeptical", "Operations manager who inherited the account and is weighing a cheaper competitor: courteous but skeptical, a little guarded until the rep owns the training failure."),
  "cs-upsell-landscaping-crews": M("upbeat", "Enthusiastic, relaxed, chatty business owner who loves the tool: upbeat and casual, open to suggestions but hesitant about spending before busy season."),
  "cs-angry-escalation-fulfillment-outage": MA("furious", "Furious senior COO after repeated outages and no updates: angry, direct and clipped, interrupts scripted apologies, never abusive; calms in stages when she hears ownership and dates."),
  // ---- procurement ----
  "procurement-purchasing-manager-cartons": G("wary", "Purchasing manager burned by late deliveries: businesslike, pointed questions about reliability, measured and a bit wary."),
  "procurement-category-manager-price-cut": MA("firm", "Seasoned category manager negotiating hard: calm, controlled and unemotional, comfortable with pauses, keeps pushing on price."),
  "procurement-sourcing-director-consolidation": C("analytical", "Strategic sourcing director running a vendor consolidation: deliberate and authoritative, formal, unhurried and analytical; respects process."),
  // ---- recruiting ----
  "recruiting-active-candidate-support-lead": G("eager", "Enthusiastic, articulate candidate laid off six weeks ago: upbeat and eager with an undercurrent of urgency; honest about the gap."),
  "recruiting-hiring-manager-intake-budget-gap": M("pressured", "Engineering director under a deadline after a launch slipped: fast and practical, a little impatient about the budget gap."),
  "recruiting-passive-candidate-cold-outreach": G("wary", "Senior designer who ignores recruiter messages: surprised, cautious and slightly wary at first; warms only if the pitch is specific and respectful."),
  // ---- logistics ----
  "logistics-small-shipper-ltl-quote": U("anxious", "Friendly small-business owner new to freight, anxious about damage and the Thursday appointment: warm and chatty, unsure of the jargon, asks basic questions."),
  "logistics-owner-operator-rate-negotiation": C("skeptical", "Independent trucker weighing a load: plain-spoken and practical, unhurried but sharp about money, skeptical of rate talk."),
  "logistics-shipper-missed-deliveries-recovery": MA("frustrated", "Logistics manager stung by chargebacks: tense, controlled frustration, direct and fact-driven."),
  // ---- telecom and utilities ----
  "telecom-inbound-home-internet-new-mover": G("rushed", "New renter with a deadline: friendly, a bit rushed and practical, wary of hidden fees, keen to get it settled before Saturday."),
  "telecom-wireless-cancel-retention": M("firm", "Account holder calling to cancel after a rival offer: polite but decided, flat and firm, willing to listen only to real value."),
  "telecom-energy-bill-shock-dispute": MA("furious", "Furious homeowner after bill shock: sharp, fast and pointed, threatening a regulator complaint; settles only when taken seriously."),
  // ---- insurance ----
  "insurance-first-solo-auto-quote": M("uncertain", "Young adult buying a first policy: casual, a bit unsure and pressed by the temporary tag, asks plain questions.", 24),
  "insurance-renewal-premium-jump": MA("upset", "Long-time customer of nine years stunned by a premium jump: measured but upset, loyal yet ready to shop around."),
  "insurance-landscaper-liability-discovery": M("practical", "Small-business co-owner needing coverage to bid a job: practical and plain-spoken, a little rushed, unfamiliar with insurance terms."),
  // ---- mortgage ----
  "mortgage-first-time-buyer-preapproval": M("nervous", "First-time buyer new to lending: eager and a bit nervous, assumes things, asks basic questions; relieved when it is explained simply.", 29),
  "mortgage-refinance-loan-estimate-comparison": G("skeptical", "Careful homeowner comparing a Loan Estimate to a 'no closing costs' quote: analytical, polite but skeptical, wants numbers.", 44),
  "mortgage-locked-borrower-threatening-to-walk": M("stressed", "Stressed buyer with a rate lock about to expire: tense and short-tempered, voice tight; calms only with concrete action.", 38),
  // ---- real estate ----
  "real-estate-portal-buyer-inquiry": M("curious", "Online inquirer, casually curious and a little noncommittal: relaxed, short answers, opens up as rapport builds.", 33),
  "real-estate-fsbo-seller-follow-up": MA("guarded", "Experienced homeowner selling the house herself: proud, a bit defensive and settled, slower and measured; wary of agents' pitches.", 61),
  "real-estate-expired-listing-cold-call": C("weary", "Homeowner worn down by a dozen agent calls: weary, curt and cynical, tired of pitches; only a real difference holds attention.", 52),
  // ---- solar ----
  "solar-inbound-web-estimate-request": G("pragmatic", "Cost-focused homeowner who requested an estimate online: pragmatic and friendly, pushes for a price early."),
  "solar-loan-vs-ppa-follow-up": C("analytical", "Homeowner weighing two offers: thoughtful and analytical, comparing numbers aloud, politely noncommittal.", 47),
  "solar-burned-homeowner-discovery": MA("distrustful", "Distrustful homeowner burned by a closed installer: guarded, clipped and bitter at first; thaws slowly if met with honesty.", 58),
  // ---- auto ----
  "auto-inbound-used-crossover-lead": G("confident", "Prepared shopper with a trade-in and a pre-approval: businesslike, friendly, informed and confident.", 36),
  "auto-pickup-negotiation-rival-quote": MA("firm", "Firm buyer holding a competing written quote: direct and composed, negotiating, unimpressed by pressure.", 52),
  "auto-conditional-approval-payment-gap": M("irritated", "Shopper surprised by a payment far above the advertised price: disappointed and suspicious, controlled irritation.", 41),
  // ---- medical devices ----
  "medical-surgeon-vessel-sealer": MA("reserved", "Busy surgeon with a ten-minute limit: polite but brief, precise and clinical, impatient with fluff, wants evidence first."),
  "medical-vac-line-kit": U("formal", "Value-analysis manager running intake: procedural, even and process-minded, formal and unhurried."),
  "medical-clinic-vitals-station": M("practical", "Clinic office manager handling purchasing: friendly, practical and budget-conscious, defers to the lead physician."),
  // ---- retail ----
  "retail-tv-soundbar-upsell": G("rushed", "Friendly, slightly rushed shopper reserving a TV for tonight: upbeat, in a hurry, open to a quick suggestion."),
  "retail-gym-cancellation-save": M("firm", "Polite but firm member set on canceling: calm and steady, a little tired of the topic."),
  "retail-furniture-financing": MA("cautious", "Careful shopper evaluating financing, skeptical from past experience: deliberate, questions the fine print, polite but cautious."),
  // ---- collections ----
  "collections-first-past-due": M("embarrassed", "Borrower embarrassed by a failed autopay: apologetic, a bit defensive, quick to explain, cooperative."),
  "collections-hardship-plan": U("stressed", "Borrower laid off seven weeks ago: stressed, quiet and ashamed, voice low and tired, guarded about money."),
  "collections-disputed-debt": G("indignant", "Consumer contesting a bill she says she never owed: firm, indignant and precise, repeats the dispute and is not rattled."),
  // ---- financial advising ----
  "financial-401k-rollover": C("cautious", "Mid-career professional in the early fifties (no exact age stated): thoughtful and a bit cautious, wants to avoid mistakes with a large old 401(k)."),
  "financial-market-drop-client": C("anxious", "Long-time client about four years from retirement after a market drop: anxious and speaking fast, wants out; softens when heard, and says his wife is just as worried."),
  "financial-small-business-401k": MA("practical", "Practical small-business owner new to retirement plans: direct and friendly, cost-conscious, skeptical of complexity."),
  // ---- home services ----
  "home-services-hvac-replacement": G("stressed", "Homeowner whose AC failed in a heat wave: hot and tired, urgency in the voice, weighing repair against replacement."),
  "home-services-pest-renewal": C("friendly", "Friendly customer questioning a renewal: easygoing and chatty, mildly price-sensitive, open to reassurance."),
  "home-services-kitchen-remodel": M("excited", "Homeowner planning a big remodel with a budget gap: excited about the plan but anchored on a lower informal quote; has to run it by his wife; gets realistic as details come."),
};

/**
 * The personas whose full text (role, title, script, goal, rubric, behavior, opening line, sample replies) never states
 * a gender. They are the only ones cast marin as "unspecified".
 */
export const UNSPECIFIED_GENDER = [
  "home-services-inbound-lead",
  "objection-handling",
  "sdr-gatekeeper-cfo-assistant",
  "logistics-small-shipper-ltl-quote",
  "medical-vac-line-kit",
  "collections-hardship-plan",
] as const;

/** The persona with its GPT-Live cast applied. A persona with no line keeps its own fields (tests flag that). */
export function withLiveCast(s: Scenario): Scenario {
  const c = LIVE_CASTING[s.id];
  if (!c) return s;
  return {
    ...s,
    aiPersona: {
      ...s.aiPersona,
      liveVoice: c.voice,
      liveDelivery: c.delivery,
      emotion: c.emotion,
      ...(c.gender ? { gender: c.gender } : {}),
      ...(c.age !== undefined ? { age: c.age } : {}),
    },
  };
}
