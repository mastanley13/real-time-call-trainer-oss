/**
 * Copy for the public /vs comparison pages and the /alternatives hub. Pure data, safe on server and client.
 *
 * Source: Scout Owl drafts in ct-gtm-artifacts/seo (vs-second-nature.md, vs-hyperbound.md, vs-yoodli.md,
 * alternatives.md), rechecked on 25 November 2026. Keep the copy as written. Do not add competitor prices, review
 * counts or ratings that the drafts do not state.
 *
 * Inline text uses a small markdown subset rendered by components/compare/ComparePage.tsx: [label](href) for links
 * and `code` for paths and URLs. Each FAQ item keeps the plain-text answer from the draft's FAQPage JSON-LD in `ld`.
 */
import { COMPARISON_SLUGS, type ComparisonSlug } from "@/lib/publicPaths";

/** Inline text: [label](href) links and `code` spans. */
export type Rich = string;

export type Block =
  | { p: Rich }
  | { ul: Rich[] }
  | { table: { head: [string, string, string]; rows: [Rich, Rich, Rich][] } };

export interface Section {
  /** Omitted for an intro that sits directly under the H1. */
  heading?: string;
  blocks: Block[];
}

export interface FaqEntry {
  q: string;
  /** Visible answer, with inline links. */
  a: Rich;
  /** The FAQPage JSON-LD answer, exactly as the draft writes it. */
  ld: string;
}

export type CompareKind = "vs" | "hub" | "alt" | "topic";

export interface ComparePageCopy {
  kind: CompareKind;
  path: string;
  title: string;
  description: string;
  h1: string;
  subhead: string;
  /** The `src` value on the sign-up CTA. */
  src: string;
  sections: Section[];
  faq: FaqEntry[];
  /** Breadcrumb label for this page. Hubs default to "Alternatives" when omitted. */
  crumb?: string;
  /** Parent crumb. `/vs` and `/alternatives/*` default to the alternatives hub. */
  parent?: { name: string; path: string };
  /** Defaults to CollectionPage on hubs and WebPage everywhere else. */
  jsonLdType?: "WebPage" | "CollectionPage";
}

export const ALTERNATIVES_PATH = "/alternatives";
export const PRIMARY_CTA_LABEL = "Start free, no card";
export const SECONDARY_CTA = { label: "See Call Trainer pricing", href: "/pricing" } as const;
export const ALTERNATIVES_LINK_LABEL = "AI sales roleplay alternatives";

export const VS_PAGES: Record<ComparisonSlug, ComparePageCopy> = {
  "second-nature": {
    kind: "vs",
    path: "/vs/second-nature",
    title: "Call Trainer vs Second Nature | Pricing and Fit",
    description:
      "A fair look at Call Trainer and Second Nature, from public pages checked on 25 November 2026. Published prices, coaching, and who each one may fit.",
    h1: "Call Trainer vs Second Nature",
    subhead: "A fair look at pricing, coaching, and fit, based on each company's public pages as of 25 November 2026.",
    src: "vs-second-nature",
    sections: [
      {
        heading: "Why this page exists",
        blocks: [
          { p: "Call Trainer sells hosted AI call practice. Second Nature sells AI role play and coaching for customer-facing teams. This page compares what each company published on its own site on 25 November 2026. It is not a paid review, and it does not rank one product as \"best.\"" },
          { p: "Sources checked that day:" },
          {
            ul: [
              "[Second Nature home](https://secondnature.ai/)",
              "[Second Nature product](https://secondnature.ai/product/)",
              "[Second Nature, See Second Nature in Action / Get a Demo](https://secondnature.ai/get-a-demo/)",
              "[Second Nature, Free Role Plays / Sales Simulations](https://secondnature.ai/resources/free-simulations/)",
              "[Call Trainer home](https://calltrainer.tech/)",
              "[Call Trainer pricing](https://calltrainer.tech/pricing)",
            ],
          },
          { p: "A request for `https://secondnature.ai/pricing` redirected to `http://secondnature.ai/pricing/` and that HTTP URL returned HTTP 500 on 25 November 2026, the same outcome as on 21 November 2026. This page does not quote a Second Nature price." },
        ],
      },
      {
        heading: "What each product is for",
        blocks: [
          { p: "Second Nature describes itself as AI role play sales training software. Its public site talks about AI role plays and coaching for customer-facing teams, including sales, and its navigation also points to industries such as insurance, technology, telco, financial services, and education, and to use cases such as learning and development, customer support, human resources, call center, and sales. The demo page invites teams to book a walkthrough and to ask about products, services, pricing, and plans. The product page includes CTAs to try a role play or a free AI simulation, and to book a demo." },
          { p: "The public navigation still includes a \"Free Role Plays\" item. On 25 November 2026 that item pointed at [secondnature.ai/resources/free-simulations/](https://secondnature.ai/resources/free-simulations/), which loaded successfully (HTTP 200). That page lists free AI role plays you can try, including customizable cold calling and B2B discovery, a customer-service complaint scenario, an interview simulation, and MEDDPICC practice. Some experiences ask you to enter information to begin, and the page says to access the free AI role play on a desktop. \"Book a Demo\" remains available on the same page. This is a starting experience, not a published price list." },
          { p: "Call Trainer describes itself as hosted AI sales call practice with no setup. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. The live site publishes three hosted plans, industry `/for` pages, and `/try` pages that start a single practice call. A [/compete](/compete) page is also live. Self-hosting stays free under the MIT license." },
        ],
      },
      {
        heading: "Pricing, as published on 25 November 2026",
        blocks: [
          {
            table: {
              head: ["Topic", "Call Trainer", "Second Nature"],
              rows: [
                ["Public price list", "Yes, on [/pricing](https://calltrainer.tech/pricing)", "No public price list loaded. `https://secondnature.ai/pricing` redirected to HTTP and returned HTTP 500. The published path for pricing questions on the site is [Get a Demo](https://secondnature.ai/get-a-demo/)."],
                ["Free starting point", "Free plan, $0, no card, 10 voice minutes a month, unlimited text practice", "A \"Free Role Plays\" item in the public navigation leads to [free simulations](https://secondnature.ai/resources/free-simulations/), which loaded on 25 November 2026 and offers free role-play experiences, some of which ask you to enter information to begin."],
                ["Individual paid plan", "Pro, $29 a month or $290 a year, 200 voice minutes a month", "Not published on a page we could load"],
                ["Team plan", "Team, $59 per seat per month or $590 per seat per year, 3-seat minimum, 300 pooled voice minutes per seat", "Not published on a page we could load"],
                ["Overage charges", "None, on any published plan", "Not published on a page we could load"],
                ["Self-host", "Free under the MIT license, with your own keys and database", "Not described on the pages we checked"],
              ],
            },
          },
          { p: "If Second Nature later publishes a price list, this comparison should be updated. We will not invent a number in the meantime." },
        ],
      },
      {
        heading: "Coaching and practice, as described on those pages",
        blocks: [
          { p: "Call Trainer's live pages describe a brief, a call, and a debrief. During the call, a coach rail only the agent can see can score each turn and offer a cue. After the call, every score cites words from the transcript, and you can retry from a chosen turn. Practice can be voice or text. Pro and Team include a persona wizard for building your own buyers. Those details are on the live home and pricing pages recrawled on 25 November 2026." },
          { p: "Second Nature's public pages describe AI-driven role plays for scenarios such as discovery calls, objection handling, and cold calling, plus coaching that helps teams practice on their own. The free-simulations page also lists customer-service and interview practice, and notes that some role plays can be personalized. The demo page offers a walkthrough. This page does not claim how Second Nature scores a paid or enterprise session beyond what those public pages state, and it does not repeat customer-result figures from Second Nature's homepage." },
        ],
      },
      {
        heading: "Who each one may fit",
        blocks: [
          { p: "Second Nature may fit an enterprise enablement team that wants a guided demo and a broader role-play platform across sales and other customer-facing roles, and that is comfortable starting from a demo or from the public free role plays. That is how its public site presents the product." },
          { p: "Call Trainer may fit a manager or individual who wants a published price, a free start with no card, a live coach during the call, a debrief that quotes the transcript, and a first practice call the same day. Industry try pages are already live for insurance, staffing, dealership, and real estate." },
          { p: "Some teams will want to try both. We would rather you do that than take our word for a comparison." },
        ],
      },
      {
        heading: "What this page does not claim",
        blocks: [
          { p: "We do not have Second Nature's contract pricing, implementation time, or customer results. We do not cite review counts or testimonials from either side on this page. Feature lists change. Recheck both sites before you buy." },
        ],
      },
    ],
    faq: [
      {
        q: "Does Call Trainer publish its prices?",
        a: "Yes. Free is $0, Pro is $29 a month or $290 a year, and Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on [/pricing](https://calltrainer.tech/pricing), recrawled on 25 November 2026.",
        ld: "Yes. Free is $0, Pro is $29 a month or $290 a year, and Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on https://calltrainer.tech/pricing, recrawled on 25 November 2026.",
      },
      {
        q: "Does Second Nature publish its prices?",
        a: "Not on a page we could load on 25 November 2026. The URL `https://secondnature.ai/pricing` redirected to `http://secondnature.ai/pricing/` and returned HTTP 500. The public path for pricing questions was to [book a demo](https://secondnature.ai/get-a-demo/).",
        ld: "Not on a page we could load on 25 November 2026. The URL https://secondnature.ai/pricing redirected to http://secondnature.ai/pricing/ and returned HTTP 500. The public path for pricing questions was to book a demo at https://secondnature.ai/get-a-demo/.",
      },
      {
        q: "Does Second Nature offer a free way to try a role play?",
        a: "Yes, on the public site. The navigation's \"Free Role Plays\" item points to [secondnature.ai/resources/free-simulations/](https://secondnature.ai/resources/free-simulations/), which loaded on 25 November 2026 and lists free role-play experiences. Some ask you to enter information to begin, and the page says to use a desktop.",
        ld: "Yes, on the public site. The navigation's Free Role Plays item points to https://secondnature.ai/resources/free-simulations/, which loaded on 25 November 2026 and lists free role-play experiences. Some ask you to enter information to begin, and the page says to use a desktop.",
      },
      {
        q: "Can I start Call Trainer without a demo?",
        a: "Yes. You can start the Free plan with no card, or go straight to Pro. Teams that want a walkthrough can also [book a demo](/demo).",
        ld: "Yes. You can start the Free plan with no card, or go straight to Pro. Teams that want a walkthrough can also book a demo at https://calltrainer.tech/demo.",
      },
      {
        q: "Is this an independent review?",
        a: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026, and it is written to be fair, not to score a winner.",
        ld: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026, and it is written to be fair, not to score a winner.",
      },
      {
        q: "What if I already use Second Nature?",
        a: "You can still try Call Trainer on Free and see whether the live coach and transcript-quoted debrief are useful next to the tools you have. We will not tell you to rip anything out.",
        ld: "You can still try Call Trainer on Free and see whether the live coach and transcript-quoted debrief are useful next to the tools you have. We will not tell you to rip anything out.",
      },
      {
        q: "Do you have a deeper feature matrix?",
        a: "Only what both sites published on the dates above. If you need a line-by-line security or integration comparison, ask both vendors directly.",
        ld: "Only what both sites published on 25 November 2026. If you need a line-by-line security or integration comparison, ask both vendors directly.",
      },
    ],
  },

  hyperbound: {
    kind: "vs",
    path: "/vs/hyperbound",
    title: "Call Trainer vs Hyperbound | Pricing and Fit",
    description:
      "A fair look at Call Trainer and Hyperbound, from public pages checked on 25 November 2026. Free starting points, published plans, and who each may fit.",
    h1: "Call Trainer vs Hyperbound",
    subhead: "A fair look at pricing, practice, and fit, based on each company's public pages as of 25 November 2026.",
    src: "vs-hyperbound",
    sections: [
      {
        heading: "Why this page exists",
        blocks: [
          { p: "Both Call Trainer and Hyperbound offer AI sales roleplay. This page compares what each company published on its own site on 25 November 2026. It is not a paid review, and it does not name a winner." },
          { p: "Sources checked that day:" },
          {
            ul: [
              "[Hyperbound home](https://www.hyperbound.ai/)",
              "[Hyperbound pricing](https://www.hyperbound.ai/pricing)",
              "[Call Trainer home](https://calltrainer.tech/)",
              "[Call Trainer pricing](https://calltrainer.tech/pricing)",
            ],
          },
        ],
      },
      {
        heading: "What each product is for",
        blocks: [
          { p: "Hyperbound describes itself as an AI sales roleplay and coaching platform. Its home page says it analyzes sales calls and helps reps practice the scenarios they struggle with. Its pricing page groups the product into Free, Practice, and Perform, and it also describes related products such as Hyperbound Perform for call insights and deal execution." },
          { p: "Call Trainer describes itself as hosted AI sales call practice with no setup. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. Hosted plans are published on the pricing page. A [/compete](/compete) page is also live. Self-hosting stays free under the MIT license." },
        ],
      },
      {
        heading: "Pricing, as published on 25 November 2026",
        blocks: [
          {
            table: {
              head: ["Topic", "Call Trainer", "Hyperbound"],
              rows: [
                ["Public price list", "Yes, on [/pricing](https://calltrainer.tech/pricing)", "Yes, on [hyperbound.ai/pricing](https://www.hyperbound.ai/pricing). The page is introduced as \"Plans that meet your team where they're at,\" lists Free, Practice, and Perform, and invites you to book a demo on the paid plans."],
                ["Free starting point", "Free plan, $0, no card, 10 voice minutes a month, unlimited text practice", "A Free plan that includes 45 prebuilt AI roleplays and prebuilt example scorecards, with a \"Try a free roleplay\" path."],
                ["Individual paid plan", "Pro, $29 a month or $290 a year, 200 voice minutes a month", "Practice is listed as an enterprise plan with \"Book a demo.\" A public monthly dollar amount was not shown for Practice or Perform on the page we loaded. The pricing FAQ says Hyperbound is priced per user, with separate licenses available for Practice and Perform."],
                ["Team or enterprise plan", "Team, $59 per seat per month or $590 per seat per year, 3-seat minimum, 300 pooled voice minutes per seat, manager view and assignments", "Practice and Perform are presented as enterprise plans, each with \"Book a demo.\" Perform is described as including everything in Practice, plus real call scoring, deal coaching, CRM intelligence, conversation intelligence, bite-sized roleplays, and call capture and integrations. The FAQ says enterprise plans include SSO, advanced security and permissions, dedicated customer success, premium support, and enterprise-ready pricing, and that volume discounts and multi-year savings are available. Contact the team for custom pricing."],
                ["Overage charges", "None, on any published plan", "Not stated as a public dollar overage on the page we loaded"],
                ["Self-host", "Free under the MIT license", "Not described on the pages we checked"],
              ],
            },
          },
          { p: "Hyperbound's paid path, on the public pricing page, is to book a demo. Call Trainer's paid path can be self-serve at a published price, or a [demo](/demo) if you want a walkthrough." },
          { p: "A headline used on Hyperbound's pricing page on 21 November 2026, \"Start free. Upgrade when your team is ready,\" was not present in the page text loaded on 25 November 2026, so this page no longer quotes it." },
        ],
      },
      {
        heading: "Coaching and practice, as described on those pages",
        blocks: [
          { p: "Call Trainer's live pages, recrawled on 25 November 2026, describe a live coach during the call, a graded debrief with transcript quotes, retry from a turn, voice or text, and a persona wizard on Pro and Team." },
          { p: "Hyperbound's public pricing page lists, on Practice, AI sales roleplays, AI buyer bot customization, reporting and analytics, custom AI scorecards, custom AI coaching, Kota features, a dedicated AM and CSM, and custom onboarding. Perform adds real call scoring and related coaching and CRM features. This page does not claim how those features feel in a session beyond what the public page lists." },
        ],
      },
      {
        heading: "Who each one may fit",
        blocks: [
          { p: "Hyperbound may fit a sales team that wants roleplay plus, on Perform, real-call scoring and CRM-connected coaching, and that is ready to book a demo for a paid plan. That is how the public pricing page is set up." },
          { p: "Call Trainer may fit a manager or individual who wants a published per-seat or per-month price, a free start with no card, unlimited text practice, a live in-call coach, and a first call the same day." },
          { p: "If you searched for a Hyperbound alternative rather than a line-by-line comparison, start at [Hyperbound alternative](/alternatives/hyperbound)." },
          { p: "If you need conversation intelligence on live sales calls, look carefully at Hyperbound Perform and at whatever else you already use for call recording. Call Trainer's public site is about practice calls, not a live-call recording suite." },
        ],
      },
      {
        heading: "What this page does not claim",
        blocks: [
          { p: "We do not have Hyperbound's quoted enterprise price, contract terms, or customer results. We do not cite review counts. Feature lists change. Recheck both sites before you buy." },
        ],
      },
    ],
    faq: [
      {
        q: "Does Call Trainer publish a Team price?",
        a: "Yes. Team is $59 per seat per month, or $590 per seat per year, with a 3-seat minimum. Details are on [/pricing](https://calltrainer.tech/pricing), recrawled on 25 November 2026.",
        ld: "Yes. Team is $59 per seat per month, or $590 per seat per year, with a 3-seat minimum. Details are on https://calltrainer.tech/pricing, recrawled on 25 November 2026.",
      },
      {
        q: "Does Hyperbound publish a paid monthly price?",
        a: "On 25 November 2026, [Hyperbound's pricing page](https://www.hyperbound.ai/pricing) listed Free, then Practice and Perform as enterprise plans with a \"Book a demo\" CTA. The FAQ says pricing is per user, with separate licenses for Practice and Perform, and that custom pricing is available. A public dollar amount for those paid plans was not on the page we loaded.",
        ld: "On 25 November 2026, Hyperbound's pricing page listed Free, then Practice and Perform as enterprise plans with a Book a demo CTA. The FAQ says pricing is per user, with separate licenses for Practice and Perform, and that custom pricing is available. A public dollar amount for those paid plans was not on the page we loaded.",
      },
      {
        q: "Can I try both for free?",
        a: "Call Trainer's Free plan is $0, no card, with 10 voice minutes a month and unlimited text practice. Hyperbound's public pricing page describes a Free plan with 45 prebuilt AI roleplays and a path to try a free roleplay. You can try each one on its own terms.",
        ld: "Call Trainer's Free plan is $0, no card, with 10 voice minutes a month and unlimited text practice. Hyperbound's public pricing page describes a Free plan with 45 prebuilt AI roleplays and a path to try a free roleplay. You can try each one on its own terms.",
      },
      {
        q: "Does Call Trainer score real customer calls?",
        a: "The public Call Trainer site describes scoring for practice calls, with debriefs that quote the practice transcript. It does not describe a live-call recording or conversation intelligence product. Hyperbound's Perform plan, on its pricing page, lists real call scoring and conversation intelligence.",
        ld: "The public Call Trainer site describes scoring for practice calls, with debriefs that quote the practice transcript. It does not describe a live-call recording or conversation intelligence product. Hyperbound's Perform plan, on its pricing page, lists real call scoring and conversation intelligence.",
      },
      {
        q: "Is this an independent review?",
        a: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026.",
        ld: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026.",
      },
      {
        q: "What if I need a demo instead of self-serve?",
        a: "You can [book a Call Trainer demo](/demo). Hyperbound's paid plans, on its public pricing page, also start with a demo.",
        ld: "You can book a Call Trainer demo at https://calltrainer.tech/demo. Hyperbound's paid plans, on its public pricing page, also start with a demo.",
      },
    ],
  },

  yoodli: {
    kind: "vs",
    path: "/vs/yoodli",
    title: "Call Trainer vs Yoodli | Pricing and Fit",
    description:
      "A fair look at Call Trainer and Yoodli, from public pages checked on 25 November 2026. Individual plans, team pricing, and who each one may fit.",
    h1: "Call Trainer vs Yoodli",
    subhead: "A fair look at pricing, practice, and fit, based on each company's public pages as of 25 November 2026.",
    src: "vs-yoodli",
    sections: [
      {
        heading: "Why this page exists",
        blocks: [
          { p: "Call Trainer and Yoodli both offer AI roleplay. Yoodli covers sales and a wider set of speaking practice. Call Trainer is focused on hosted call practice with a live coach and a transcript-quoted debrief. This page compares what each company published on its own site on 25 November 2026. It is not a paid review, and it does not name a winner." },
          { p: "Sources checked that day:" },
          {
            ul: [
              "[Yoodli Roleplays](https://yoodli.ai/platform/roleplays)",
              "[Yoodli sales training](https://yoodli.ai/use-cases/sales-training)",
              "[Yoodli pricing](https://yoodli.ai/pricing)",
              "[Call Trainer home](https://calltrainer.tech/)",
              "[Call Trainer pricing](https://calltrainer.tech/pricing)",
            ],
          },
        ],
      },
      {
        heading: "What each product is for",
        blocks: [
          { p: "Yoodli describes Roleplays as AI tutors, practice, and certification. Learners can practice by video, chat, or avatar, and be scored against a rubric. The sales training page talks about discovery, demos, objection handling, and price negotiation, including custom AI buyers and scoring against a sales methodology. Individual plans also cover interview prep, public speaking, and pitch practice." },
          { p: "Call Trainer describes itself as hosted AI sales call practice with no setup. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. The live site also has industry `/for` and `/try` pages for specific call types, such as an inbound auto quote or a candidate screen. A [/compete](/compete) page is also live." },
        ],
      },
      {
        heading: "Pricing, as published on 25 November 2026",
        blocks: [
          {
            table: {
              head: ["Topic", "Call Trainer", "Yoodli"],
              rows: [
                ["Public price list", "Yes, on [/pricing](https://calltrainer.tech/pricing)", "Yes, on [yoodli.ai/pricing](https://yoodli.ai/pricing). The page says individuals can get started for free, and that organizations get straightforward per-seat pricing."],
                ["Free starting point", "Free plan, $0, no card, 10 voice minutes a month, unlimited text practice", "Individuals can start free. The pricing FAQ on that page says the Starter plan includes 5 lifetime sessions."],
                ["Individual paid plan", "Pro, $29 a month or $290 a year, 200 voice minutes a month, full library, persona wizard", "The pricing FAQ, as loaded on 25 November 2026, says Pro is $8/month billed annually, with up to 10 roleplays per week, and Advanced is $20/month billed annually, with unlimited roleplays. The same FAQ notes that Advanced adds data exclusion from AI training and reimbursement as a professional development benefit. The plan cards in the HTML we loaded also showed monthly and annual billing toggles and a \"SAVE 40%\" label. We did not see a public monthly dollar amount on those cards, so this page does not infer one."],
                ["Team or business plan", "Team, $59 per seat per month or $590 per seat per year, 3-seat minimum, published on the pricing page, with a manager view and assignments", "Business is described as per seat, billed annually, with Yoodli Create, custom rubrics, Yoodli Coach, Measure dashboards, integrations, SSO, SCIM, and SOC 2 Type 2. The public CTA for Business is \"Get a Demo.\" No Business dollar amount was shown on the page we loaded. Enterprise is \"Talk to sales,\" described for organizations of 5,000 or more employees. The FAQ says to contact sales for Business and Enterprise pricing."],
                ["Overage charges", "None, on any published plan", "Not described in the same \"no overage\" language. Session limits on individual plans are described in the FAQ as noted above."],
                ["Self-host", "Free under the MIT license", "Not described on the pages we checked"],
              ],
            },
          },
          { p: "Both products let an individual start free. For teams, Call Trainer publishes a Team price on the page. Yoodli's Business and Enterprise plans, on the public pricing page, start with a demo or a conversation with sales." },
        ],
      },
      {
        heading: "Coaching and practice, as described on those pages",
        blocks: [
          { p: "Call Trainer's live pages, recrawled on 25 November 2026, emphasize a live coach during the call, a debrief that quotes the transcript, retry from a turn, a persona wizard on Pro and Team, and industry call types with dedicated `/for` and `/try` pages." },
          { p: "Yoodli's Roleplays and sales pages emphasize an AI tutor that can teach before practice, video or avatar sessions, screen share, multi-persona buying committees, and scoring against your rubric, including certifications and a Measure product for skill visibility. Those are real differences in scope. They do not make one tool universally better. They change who each one may fit." },
        ],
      },
      {
        heading: "Who each one may fit",
        blocks: [
          { p: "Yoodli may fit an individual who wants speaking, interview, or pitch practice, or an enablement team that wants tutors, certifications, and a broader human-skills platform, and that is ready to talk about a Business plan. That is how the public pages present it." },
          { p: "Call Trainer may fit a sales manager, SDR lead, or individual seller who wants call practice first, a published Team or Pro price, a live coach on the call, and a try page for a specific industry call." },
          { p: "If you searched for a Yoodli alternative for sales calls rather than a line-by-line comparison, start at [Yoodli alternative](/alternatives/yoodli)." },
          { p: "If you need video presence, a buying committee, or screen-share demos, read Yoodli's Roleplays page carefully. Call Trainer's public site is about the call itself: talk or type, get coached, read a debrief." },
        ],
      },
      {
        heading: "What this page does not claim",
        blocks: [
          { p: "We do not invent a Yoodli Business price, and we do not infer an individual monthly card price from the \"SAVE 40%\" label. We do not cite review counts or customer results. Recheck both sites before you buy." },
        ],
      },
    ],
    faq: [
      {
        q: "Can I start either product for free?",
        a: "Yes. Call Trainer's Free plan is $0, no card, with 10 voice minutes a month and unlimited text practice. Yoodli's pricing page says individuals can get started for free, and its FAQ describes a Starter plan with 5 lifetime sessions.",
        ld: "Yes. Call Trainer's Free plan is $0, no card, with 10 voice minutes a month and unlimited text practice. Yoodli's pricing page says individuals can get started for free, and its FAQ describes a Starter plan with 5 lifetime sessions.",
      },
      {
        q: "Does Call Trainer publish a Team price on the page?",
        a: "Yes. Team is $59 per seat per month, or $590 per seat per year, with a 3-seat minimum, on [/pricing](https://calltrainer.tech/pricing), recrawled on 25 November 2026.",
        ld: "Yes. Team is $59 per seat per month, or $590 per seat per year, with a 3-seat minimum, on https://calltrainer.tech/pricing, recrawled on 25 November 2026.",
      },
      {
        q: "Does Yoodli publish a Business price on the page?",
        a: "On 25 November 2026, [Yoodli's pricing page](https://yoodli.ai/pricing) described Business as per-seat, billed annually, with a \"Get a Demo\" CTA, and Enterprise as \"Talk to sales.\" No Business dollar amount was shown on the page we loaded. The FAQ says to contact sales for Business and Enterprise pricing.",
        ld: "On 25 November 2026, Yoodli's pricing page described Business as per-seat, billed annually, with a Get a Demo CTA, and Enterprise as Talk to sales. No Business dollar amount was shown on the page we loaded. The FAQ says to contact sales for Business and Enterprise pricing.",
      },
      {
        q: "What individual Yoodli prices were on the page?",
        a: "The pricing FAQ loaded on 25 November 2026 states that Pro is $8/month billed annually and Advanced is $20/month billed annually. Starter is described as 5 lifetime sessions.",
        ld: "The pricing FAQ loaded on 25 November 2026 states that Pro is $8/month billed annually and Advanced is $20/month billed annually. Starter is described as 5 lifetime sessions.",
      },
      {
        q: "Is Yoodli only for sales?",
        a: "No. Yoodli's public pages also cover interview prep, public speaking, and pitch practice, and Roleplays is described for sales, enablement, and L&D. Call Trainer's live marketing site is focused on call practice, especially sales calls.",
        ld: "No. Yoodli's public pages also cover interview prep, public speaking, and pitch practice, and Roleplays is described for sales, enablement, and L and D. Call Trainer's live marketing site is focused on call practice, especially sales calls.",
      },
      {
        q: "Is this an independent review?",
        a: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026.",
        ld: "No. Call Trainer publishes this page. The comparison is limited to public pages checked on 25 November 2026.",
      },
      {
        q: "What if I only need to practice cold calls?",
        a: "You can start on Call Trainer Free, or use the [SDR page](/for/saas-sdr). You can also try Yoodli's individual plans if that style of practice fits you better. There is no harm in trying both.",
        ld: "You can start on Call Trainer Free, or use the SDR page at https://calltrainer.tech/for/saas-sdr. You can also try Yoodli's individual plans if that style of practice fits you better. There is no harm in trying both.",
      },
    ],
  },
};

/** Title and H1 are the Jev winners from 25 November 2026. Do not change them without another Jev gate at 0.6 or higher. */
export const ALTERNATIVES_PAGE: ComparePageCopy = {
  kind: "hub",
  path: ALTERNATIVES_PATH,
  title: "AI Sales Roleplay Alternatives | Call Trainer",
  description:
    "Compare Call Trainer with Hyperbound, Second Nature, and Yoodli. A short, fair hub from public pages checked on 25 November 2026.",
  h1: "AI sales roleplay alternatives",
  subhead:
    "A short, fair look at Call Trainer next to Hyperbound, Second Nature, and Yoodli, based on each company's public pages as of 25 November 2026.",
  src: "alternatives",
  sections: [
    {
      blocks: [
        { p: "If you are comparing AI sales roleplay tools, start here. This hub links three fair comparison pages. Each one uses only what the company published on its own site, recrawled on 25 November 2026. None of them ranks a winner." },
        { p: "Call Trainer is hosted AI sales call practice. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. Free is $0, no card, with 10 voice minutes a month and unlimited text. Pro is $29 a month or $290 a year. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Those figures are on [/pricing](https://calltrainer.tech/pricing)." },
      ],
    },
    {
      heading: "The three comparisons",
      blocks: [
        {
          ul: [
            "[Call Trainer vs Hyperbound](/vs/hyperbound). Hyperbound's public pricing page lists Free, then Practice and Perform as enterprise plans with a \"Book a demo\" CTA. A paid dollar amount was not shown on the page we loaded. Call Trainer publishes self-serve prices, including Team.",
            "[Call Trainer vs Second Nature](/vs/second-nature). Second Nature's public path for pricing questions is to book a demo. Its `/pricing` URL did not return a price list on 25 November 2026. A \"Free Role Plays\" item in the navigation leads to a loaded free-simulations page.",
            "[Call Trainer vs Yoodli](/vs/yoodli). Yoodli's pricing FAQ lists individual Pro at $8/month billed annually and Advanced at $20/month billed annually. Business is per seat, billed annually, with a \"Get a Demo\" CTA and no dollar amount on the page we loaded.",
          ],
        },
        { p: "If you already know which product you are comparing, go straight to that page. If you want to practice a sales call today, you can start on Call Trainer Free with no card." },
        { p: "[Start free, no card](/register?src=alternatives) · [See pricing](/pricing)" },
      ],
    },
    {
      heading: "Hyperbound alternative and Yoodli alternative",
      blocks: [
        {
          ul: [
            "[Hyperbound alternative](/alternatives/hyperbound). For teams that want a published price and a first practice call the same day, without booking an enterprise demo first.",
            "[Yoodli alternative](/alternatives/yoodli). For sales and call-center practice, with a Team plan you can start without a demo.",
          ],
        },
        { p: "For a broader look at AI sales roleplay software, including alarm-monitoring and 911 dispatch use cases, see [AI sales roleplay software](/ai-sales-roleplay)." },
      ],
    },
    {
      heading: "What this page does not claim",
      blocks: [
        { p: "This is not an independent review, and it is not a ranked list. We do not invent competitor prices, and we do not cite review counts or customer results. Feature lists change. Recheck each site before you buy. Some teams will want to try more than one tool, and that is a reasonable way to decide." },
      ],
    },
  ],
  faq: [
    {
      q: "Is this a ranked list of the best AI sales roleplay tools?",
      a: "No. This is a short hub, published by Call Trainer, that links three fair comparisons. Each comparison is limited to public pages checked on 25 November 2026.",
      ld: "No. This is a short hub, published by Call Trainer, that links three fair comparisons. Each comparison is limited to public pages checked on 25 November 2026.",
    },
    {
      q: "Where can I compare Call Trainer with Hyperbound, Second Nature, or Yoodli?",
      a: "Use [/vs/hyperbound](/vs/hyperbound), [/vs/second-nature](/vs/second-nature), or [/vs/yoodli](/vs/yoodli). For a Hyperbound alternative or Yoodli alternative, see [/alternatives/hyperbound](/alternatives/hyperbound) and [/alternatives/yoodli](/alternatives/yoodli).",
      ld: "Use https://calltrainer.tech/vs/hyperbound, https://calltrainer.tech/vs/second-nature, or https://calltrainer.tech/vs/yoodli. For a Hyperbound alternative or Yoodli alternative, see https://calltrainer.tech/alternatives/hyperbound and https://calltrainer.tech/alternatives/yoodli.",
    },
    {
      q: "Does Call Trainer publish its prices?",
      a: "Yes. Free is $0, Pro is $29 a month or $290 a year, and Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on [/pricing](https://calltrainer.tech/pricing).",
      ld: "Yes. Free is $0, Pro is $29 a month or $290 a year, and Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on https://calltrainer.tech/pricing.",
    },
    {
      q: "Can I start without a demo?",
      a: "Yes. You can start the Free plan with no card, or go straight to Pro. Teams that want a walkthrough can also [book a demo](/demo).",
      ld: "Yes. You can start the Free plan with no card, or go straight to Pro. Teams that want a walkthrough can also book a demo at https://calltrainer.tech/demo.",
    },
    {
      q: "Do the other tools also have a way to try them?",
      a: "Yes, on their public sites, on their own terms. Hyperbound's pricing page describes a Free plan with 45 prebuilt AI roleplays. Second Nature's navigation includes Free Role Plays, which opened a free-simulations page on 25 November 2026. Yoodli's pricing page says individuals can get started for free, with a Starter plan of 5 lifetime sessions described in its FAQ.",
      ld: "Yes, on their public sites, on their own terms. Hyperbound's pricing page describes a Free plan with 45 prebuilt AI roleplays. Second Nature's navigation includes Free Role Plays, which opened a free-simulations page on 25 November 2026. Yoodli's pricing page says individuals can get started for free, with a Starter plan of 5 lifetime sessions described in its FAQ.",
    },
  ],
};

/** The hub lists the comparisons in this order (as the draft does). */
export const HUB_ORDER: readonly ComparisonSlug[] = ["hyperbound", "second-nature", "yoodli"];

export const ALL_COMPARE_PAGES: readonly ComparePageCopy[] = [ALTERNATIVES_PAGE, ...COMPARISON_SLUGS.map((s) => VS_PAGES[s])];

export type RichPart = { text: string } | { code: string } | { href: string; label: string };

const OWN_ORIGIN = "https://calltrainer.tech";
const RICH_RE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;

/**
 * Splits inline text into plain, code and link parts. Links to the live site's own origin become relative paths, so
 * previews and self-hosted copies stay on their own host. The visible label is unchanged.
 */
export function parseRich(s: Rich): RichPart[] {
  const out: RichPart[] = [];
  let last = 0;
  for (const m of s.matchAll(RICH_RE)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[3] !== undefined) out.push({ code: m[3] });
    else {
      const raw = m[2];
      const href = raw === OWN_ORIGIN || raw === `${OWN_ORIGIN}/` ? "/" : raw.startsWith(`${OWN_ORIGIN}/`) ? raw.slice(OWN_ORIGIN.length) : raw;
      out.push({ href, label: m[1] });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** The visible text of inline copy, without markup. */
export const richText = (s: Rich): string => parseRich(s).map((p) => ("text" in p ? p.text : "code" in p ? p.code : p.label)).join("");

/** One FAQPage object per page, from the draft's JSON-LD answers. */
export function faqJsonLd(page: ComparePageCopy) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.ld },
    })),
  };
}

/** Parent crumb and current-page label for breadcrumbs and JSON-LD. */
export function pageCrumbs(page: ComparePageCopy): { parent?: { name: string; path: string }; current: string } {
  const parent =
    page.parent ??
    (page.kind === "vs" || page.kind === "alt" ? { name: "Alternatives", path: ALTERNATIVES_PATH } : undefined);
  const current = page.crumb ?? (page.kind === "hub" && !parent ? "Alternatives" : page.h1);
  return { parent, current };
}

/** WebPage (CollectionPage on hubs) with a self-referencing URL and breadcrumbs. */
export function pageJsonLd(page: ComparePageCopy, origin: string) {
  const url = `${origin}${page.path}`;
  const { parent, current } = pageCrumbs(page);
  const crumbs = [
    { name: "Home", item: `${origin}/` },
    ...(parent ? [{ name: parent.name, item: `${origin}${parent.path}` }] : []),
    { name: current, item: url },
  ];
  const pageType = page.jsonLdType ?? (page.kind === "hub" ? "CollectionPage" : "WebPage");
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": pageType, "@id": url, url, name: page.title, description: page.description },
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.item })),
      },
    ],
  };
}

/** JSON for a script tag: normal JSON, with "<" escaped so the text can never close the tag. */
export const jsonLdScript = (data: unknown): string => JSON.stringify(data).replace(/</g, "\\u003c");
