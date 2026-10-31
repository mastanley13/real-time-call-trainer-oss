import { registerHref } from "@/lib/pricing";
import type { VERTICAL_SLUGS } from "@/lib/publicPaths";

export type VerticalSlug = (typeof VERTICAL_SLUGS)[number];

export type Landing = {
  slug: VerticalSlug;
  audience: string;
  title: string;
  description: string;
  hero: string;
  subhead: string;
  /** Sign-up link for the primary CTA, with seg and src. */
  primaryHref: string;
  primaryLabel: string;
  secondary: { label: string; href: string };
  pains: { title: string; body: string }[];
  steps: { title: string; body: string }[];
  /** Names must match `aiPersona.name` in src/lib/personas (checked by tests/landing.test.ts). */
  personas: { name: string; tag?: string; blurb: string }[];
  comingSoon?: { label: string; names: string[] };
  faq: { q: string; a: string }[];
  /** Pricing summary link tags. */
  src: string;
  seg?: string;
};

const STEPS: Landing["steps"] = [
  { title: "Pick a buyer.", body: "Choose a persona from the library, or build your own in the persona wizard from a job description, product page, CRM notes or a pasted call." },
  { title: "Make the call.", body: "Talk out loud in voice, or type in the text sim. The buyer pushes back." },
  { title: "Get coached live.", body: "The live coach shows a rubric estimate, talk ratio and at most one cue per moment. Choose Blind, Guided or Coached." },
  { title: "Read the debrief.", body: "Every score is backed by quotes from your own transcript. Re-grade, or use Retry from turn N to replay the moment you lost it." },
];

const NO_CARD = { q: "Do I need a card to start?", a: "No. Start free, no card." };

const sec = (label = "See pricing") => ({ label, href: "/pricing" });

export const LANDINGS: Record<VerticalSlug, Landing> = {
  insurance: {
    slug: "insurance",
    audience: "Insurance agents and agency owners",
    title: "Insurance Sales Call Training with AI Roleplay | Call Trainer",
    description: "Practice final expense, Medicare and P&C calls with AI policyholders. Live coaching and graded debriefs that quote your transcript. Start free, no card.",
    hero: "Every agent on your floor, coached on every call",
    subhead: "Practice final expense, Medicare and P&C calls against AI policyholders who push back. Get coached live, then read a debrief that quotes the exact line where the policy slipped.",
    primaryLabel: "Start free, no card",
    primaryHref: registerHref({ seg: "insurance", src: "insurance" }),
    secondary: sec(),
    src: "insurance", seg: "insurance",
    pains: [
      { title: "Leads cost too much to practice on.", body: "New agents learn on real lead cards, and every fumbled callback is money you already spent." },
      { title: "\"I already have something through the funeral home.\"", body: "The same five objections end most calls, and nobody has time to role-play them every morning." },
      { title: "Compliance is on the line every call.", body: "Pressure, false urgency or a coached health answer can cost a license. Agents need reps on doing it right, not just doing it fast." },
    ],
    steps: STEPS,
    personas: [
      { name: "Wesley Tran", blurb: "24, first auto policy on a financed used SUV before his temporary tag expires." },
      { name: "Imani Brooks", blurb: "Homeowner of nine years whose renewal jumped from $1,640 to $2,310 (41%)." },
      { name: "Owen Sorensen", blurb: "Landscaping co-owner who needs liability coverage to bid an HOA contract." },
    ],
    comingSoon: {
      label: "Coming soon in the reviewed Insurance packs for Pro and Team",
      names: [
        "Final Expense: Dorothy Mae Jenkins, Earl Watkins, Linda Okafor, Raymond Castillo, Gloria Whitfield",
        "Medicare: Harold Bennett, Bernice Albright, Victor Nguyen, Rosa Delgado, Frank O'Leary",
        "P&C: Jessica Moreno, Mike Petrakis, Tanya Brooks, Greg Lindqvist, Carol Simmons",
      ],
    },
    faq: [
      { q: "Is this compliance training?", a: "No. It is roleplay practice. Personas flag compliance-sensitive moments, like pressure or third parties answering health questions, but always follow your carrier, state and CMS rules." },
      { q: "Can I practice Medicare and final expense specifically?", a: "Today the library has auto, homeowners and commercial liability buyers. Final expense, Medicare and P&C packs are in review and ship to Pro and Team." },
      { q: "Can I build a buyer that matches my leads?", a: "Yes. The persona wizard builds one from your script, CRM notes or a pasted call." },
      { q: "Do I need a card to start?", a: "No. Free has no card and includes voice minutes plus unlimited text sim." },
    ],
  },
  solar: {
    slug: "solar",
    audience: "Residential solar reps and sales managers",
    title: "Solar Sales Training with AI Homeowner Roleplay | Call Trainer",
    description: "Practice solar estimate, loan vs PPA and skeptical homeowner calls with AI buyers. Live coaching, graded debriefs. Start free, no card.",
    hero: "Get coached live on the call that usually stalls",
    subhead: "Rehearse the estimate request, the loan versus PPA comparison and the homeowner who got burned before. Get coached live and graded on every call.",
    primaryLabel: "Start free, no card",
    primaryHref: registerHref({ seg: "solar", src: "solar" }),
    secondary: sec(),
    src: "solar", seg: "solar",
    pains: [
      { title: "\"Just send me the number.\"", body: "Homeowners want a price before they want a conversation, and new reps give it away too early." },
      { title: "Loan versus PPA confuses everyone.", body: "If your rep cannot explain it plainly, the homeowner signs with whoever can." },
      { title: "The burned-before homeowner.", body: "Distrust of solar promises kills sits before they start, and you cannot practice that on real appointments." },
    ],
    steps: STEPS,
    personas: [
      { name: "Corinne Baptiste", blurb: "$210 average bill, requested an estimate online, mainly wants the cost." },
      { name: "Abel Rinaldi", blurb: "$245 bill, weighing your 8 kW loan proposal against a no-money-down PPA." },
      { name: "Odalys Kruger", blurb: "Four-year-old system from an installer that closed, failing inverter, deep distrust." },
    ],
    comingSoon: {
      label: "Coming soon in the reviewed Solar pack for Pro and Team",
      names: ["Dan and Kelly Harper, Marcus Reed, Priya Shah, Bob Kowalski, Angela Ruiz, Tom Becker"],
    },
    faq: [
      { q: "Does it cover door-to-door or kitchen-table sits?", a: "It covers phone and video style calls: estimate requests, follow-ups and discovery. Use the persona wizard to model your own sit." },
      { q: "Will it make claims about savings for my reps?", a: "No. Personas are buyers. Your reps practice explaining your real numbers honestly." },
      { q: "Can managers see who is improving?", a: "On Team, yes. Team view shows each rep's calls, scores and trends, and you can assign personas with due dates." },
      NO_CARD,
    ],
  },
  staffing: {
    slug: "staffing",
    audience: "Recruiters and staffing agency owners",
    title: "Recruiter Call Training with AI Candidates | Call Trainer",
    description: "Practice candidate screens, intake calls and passive candidate outreach with AI. Live coaching and graded debriefs. Start free, no card.",
    hero: "Train new recruiters without burning real reqs",
    subhead: "Practice candidate screens, hiring manager intakes and passive candidate calls with AI that pushes back. Get coached live and graded on every call.",
    primaryLabel: "Start free, no card",
    primaryHref: registerHref({ seg: "staffing", src: "staffing" }),
    secondary: sec(),
    src: "staffing", seg: "staffing",
    pains: [
      { title: "The below-market req.", body: "Hiring managers want senior talent at a junior band. New recruiters agree to it and lose the placement later." },
      { title: "\"I am happy where I am.\"", body: "Passive candidates hang up in seconds unless the first line earns the next minute." },
      { title: "Desks ramp slowly.", body: "Every new recruiter learns on real candidates and real reqs, and the agency pays for the mistakes." },
    ],
    steps: STEPS,
    personas: [
      { name: "Danielle Whitaker", blurb: "Active candidate for a support team lead role, laid off six weeks ago." },
      { name: "Gareth Linden", blurb: "Engineering director who needs a senior backend engineer fast, with a band below market." },
      { name: "Nadia Kessler", blurb: "Senior product designer, promoted three months ago, unexpected recruiter call." },
    ],
    faq: [
      { q: "Is it only for agency recruiters?", a: "No. In-house talent teams use the same screens and intakes." },
      { q: "Can I model my own reqs?", a: "Yes. Paste a job description into the persona wizard to build a candidate or hiring manager." },
      { q: "Can I track my desk?", a: "On Team, the Team view shows each recruiter's calls, scores and trends, and you can assign practice." },
      NO_CARD,
    ],
  },
  "home-services": {
    slug: "home-services",
    audience: "HVAC, remodeling and pest control teams",
    title: "Home Services Sales Training: HVAC, Remodel, Pest | Call Trainer",
    description: "Practice repair or replace, renewal and price objection calls with AI homeowners. Live coaching and graded debriefs. Start free, no card.",
    hero: "Get coached live on the call that usually stalls",
    subhead: "Practice repair or replace, renewal and budget-gap calls with AI homeowners. Get a live coach on the call and a graded debrief after it.",
    primaryLabel: "Start free, no card",
    primaryHref: registerHref({ seg: "home-services", src: "home-services" }),
    secondary: sec(),
    src: "home-services", seg: "home-services",
    pains: [
      { title: "\"I got a lower quote.\"", body: "Price shoppers call three shops. The one who explains value without pressure books the job." },
      { title: "Repair or replace in a heat wave.", body: "Stressed homeowners need a clear, honest recommendation, not a pitch. New advisors rarely get practice before peak season." },
      { title: "Renewals that quietly cancel.", body: "A small price increase turns into a cancellation when the CSR cannot explain why the plan still matters." },
    ],
    steps: STEPS,
    personas: [
      { name: "Naomi Fairweather", tag: "HVAC", blurb: "15-year-old AC failed in a heat wave, weighing a $2,350 repair against replacement." },
      { name: "Tomasz Kowalczyk", tag: "Pest control", blurb: "Quarterly plan going from $119 to $129, wondering if he still needs it." },
      { name: "Rohan Prasad", tag: "Remodeling", blurb: "Full kitchen remodel with $30,000 in mind and a much lower informal quote." },
      { name: "Calvin Okpara", blurb: "Landscaping owner adding three crews." },
    ],
    faq: [
      { q: "Is it for techs or the office?", a: "Both. CSRs, comfort advisors and owners all use the same buyers. Pick the call type that fits the role." },
      { q: "Can I add my own services and pricing?", a: "Yes. The persona wizard builds a homeowner from your price sheet, script or a pasted call." },
      { q: "How long does a practice call take?", a: "Most take a few minutes. The text sim works with no mic." },
      NO_CARD,
    ],
  },
  "saas-sdr": {
    slug: "saas-sdr",
    audience: "SaaS SDRs, AEs and SDR managers",
    title: "Cold Call Practice for SDRs with AI Prospects | Call Trainer",
    description: "SDR and AE roleplay: gatekeepers, cold calls and discovery with AI prospects. Live coaching, graded debriefs. Start free, no card.",
    hero: "Your SDR floor, coached on every call",
    subhead: "Cold calls, gatekeepers, referrals and discovery with AI prospects who push back. Live coaching on the dial, and a debrief that quotes the line where you lost them.",
    primaryLabel: "Start free, no card",
    primaryHref: registerHref({ seg: "saas", src: "saas-sdr" }),
    secondary: sec(),
    src: "saas-sdr", seg: "saas",
    pains: [
      { title: "Burning accounts to learn.", body: "New SDRs learn the opener on your best-fit accounts, and every bad first dial is hard to undo." },
      { title: "Managers cannot shadow every call.", body: "Role-play gets skipped when the floor is busy, so feedback comes too late or not at all." },
      { title: "\"We already use something.\"", body: "Discovery turns into a pitch the moment the prospect pushes back, and the meeting dies." },
    ],
    steps: STEPS,
    personas: [
      { name: "Desmond Hale", blurb: "Executive assistant guarding the CFO at a 220-person manufacturer." },
      { name: "Gabriela Ostrowski", blurb: "VP of Operations at a 40-person freight brokerage, answering her own line." },
      { name: "Camille Aubert", blurb: "Operations director at a clinic group, expecting a referral call." },
      { name: "Lucia Brandvold", tag: "AE discovery", blurb: "Skeptical CFO with an incumbent contract." },
      { name: "Thandiwe Mokoena", tag: "AE discovery", blurb: "IT director with an audit finding and a committee." },
      { name: "Teodora Petrov", tag: "AE discovery", blurb: "Agency founder who requested a demo." },
    ],
    faq: [
      { q: "Does it replace call shadowing?", a: "It gives every rep reps between shadows. Managers on Team see scores and trends and can assign specific personas." },
      { q: "Can it use our ICP and messaging?", a: "Yes. The persona wizard builds a prospect from a job description, product page or CRM notes." },
      { q: "Voice or text?", a: "Both. Voice for realistic dials, text sim when there is no mic or to save minutes." },
      NO_CARD,
    ],
  },
  coaches: {
    slug: "coaches",
    audience: "Sales coaches, trainers and enablement leads",
    title: "Sales Coach Partner Program: Free Seat + 20% Recurring | Call Trainer",
    description: "Give your clients AI buyers to practice on between sessions. Approved coaches get a free seat and 20% recurring commission.",
    hero: "Scale your coaching without scaling your calendar",
    subhead: "Get a free seat, give your clients AI buyers to practice on between sessions, and earn 20% recurring on every paid plan you refer.",
    primaryLabel: "Apply to partner",
    primaryHref: "mailto:support@calltrainer.tech?subject=Coach%20partner%20application",
    secondary: { label: "Try it free first", href: registerHref({ src: "coaches" }) },
    src: "coaches",
    pains: [
      { title: "Your clients do not practice between sessions.", body: "You teach the framework Tuesday, and by the next call it is gone." },
      { title: "Role-play does not scale.", body: "Every drill you run live costs an hour of your calendar." },
      { title: "You cannot see the gaps.", body: "Without transcripts you coach from memory and self-reports." },
    ],
    steps: [
      { title: "Apply.", body: "We review every application." },
      { title: "Get set up.", body: "Approved partners get a free seat, a referral link and a partner code." },
      { title: "Your clients practice.", body: "They practice on AI buyers, get coached live and graded with transcript quotes. Build personas for your own methodology in the persona wizard." },
      { title: "Earn 20%.", body: "You earn 20% of net paid revenue on plans you refer, paid monthly, net 30." },
    ],
    personas: [
      { name: "Desmond Hale", tag: "Gatekeeper", blurb: "Executive assistant guarding the CFO at a 220-person manufacturer." },
      { name: "Imani Brooks", tag: "Insurance renewal", blurb: "Homeowner of nine years whose renewal jumped from $1,640 to $2,310 (41%)." },
      { name: "Odalys Kruger", tag: "Solar distrust", blurb: "Four-year-old system from an installer that closed, failing inverter, deep distrust." },
    ],
    faq: [
      { q: "Who qualifies?", a: "Sales coaches, trainers, enablement leads, managers who train reps and bootcamps with an existing audience or client base." },
      { q: "Do I have to sell?", a: "No quotas. Share it where it helps your clients." },
      { q: "When do I get paid?", a: "Monthly, net 30 after the customer payment clears. No commission on refunds or chargebacks. Self-referrals are not eligible." },
      { q: "Can I contribute persona packs?", a: "Yes. The project is MIT open source and reviewed packs ship to Pro and Team." },
    ],
  },
};

export const PARTNER_BENEFITS = [
  "Free seat for you",
  "20% recurring commission on referred paid plans, every paid seat on referred teams counts",
  "Early access to persona packs and the chance to contribute your own to the MIT repo",
];

export const PARTNER_RULES = [
  "Disclose clearly: \"I get a commission if you sign up through my link.\" In videos, say it on screen and repeat it in live streams.",
  "No cold email, cold DMs, mass messages or scraping. Promote only to your own audience and where self-promotion is allowed.",
  "No result or income claims we have not published. No brand keyword bidding or lookalike domains.",
  "Either side can end with 14 days' notice.",
];

export const CLOSING = "Your next tough call is already on the calendar. Practice it first.";
