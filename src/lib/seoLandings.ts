/**
 * Copy for public SEO landings: /alternatives/hyperbound, /alternatives/yoodli, /ai-sales-roleplay,
 * /use-cases/alarm-monitoring and /use-cases/911-dispatch. Pure data, safe on server and client.
 *
 * Competitor facts match src/lib/comparisons.ts (public pages checked on 25 November 2026). Do not add competitor
 * prices, review counts, ratings, logos or testimonials those pages do not state. Use-case pages do not invent
 * library personas; alarm monitoring and 911 dispatch are practiced with the persona wizard.
 *
 * Inline text uses the same markdown subset as comparisons.ts: [label](href) and `code`.
 */
import type { ComparePageCopy } from "@/lib/comparisons";
import { ROLEPLAY_HUB_PATH } from "@/lib/publicPaths";

export const ROLEPLAY_HUB_PAGE: ComparePageCopy = {
  kind: "hub",
  path: ROLEPLAY_HUB_PATH,
  crumb: "AI sales roleplay",
  title: "AI Sales Roleplay Software | Call Trainer",
  description:
    "AI sales roleplay software for objection calls: live coaching, transcript-quoted grading, and a free start with no card. Compare alternatives and use cases.",
  h1: "AI sales roleplay software",
  subhead:
    "Practice the sales or service call before it costs you the deal. Talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript.",
  src: "ai-sales-roleplay",
  sections: [
    {
      blocks: [
        { p: "AI sales roleplay software lets a rep rehearse a live conversation against an AI buyer instead of a teammate or a real lead. Call Trainer is hosted call practice: you pick a persona, make the call in voice or text, get coached on the turn, and read a debrief that cites the words you actually said." },
        { p: "Free is $0, no card, with 10 voice minutes a month and unlimited text. Pro is $29 a month or $290 a year, with 200 voice minutes a month. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum and 300 pooled voice minutes per seat. Those figures are on [/pricing](/pricing)." },
      ],
    },
    {
      heading: "What you get on the call",
      blocks: [
        {
          ul: [
            "A briefing, then a voice or text call against an AI buyer who pushes back.",
            "A live coach only you can see: a rubric estimate, talk-track progress, and at most one cue per turn.",
            "A graded debrief that quotes your transcript. Retry from a chosen turn.",
            "A persona wizard on Pro and Team, so you can build a buyer from a script, a product page, CRM notes or a pasted call.",
            "A Team view for managers: scores, assignments and a coaching queue.",
          ],
        },
        { p: "The coach is never sent to the persona. \"Use line\" drops a suggested line into the composer and does not send it." },
      ],
    },
    {
      heading: "Alternatives and comparisons",
      blocks: [
        {
          ul: [
            "[Hyperbound alternative](/alternatives/hyperbound). Hyperbound's paid Practice and Perform plans, on its public pricing page, start with a demo. Call Trainer publishes self-serve prices.",
            "[Yoodli alternative](/alternatives/yoodli). Yoodli covers sales and a wider set of speaking practice. Call Trainer is built for sales calls and call-center practice, with a published Team plan.",
            "[AI sales roleplay alternatives](/alternatives) hub, plus line-by-line pages: [Call Trainer vs Hyperbound](/vs/hyperbound), [vs Second Nature](/vs/second-nature), and [vs Yoodli](/vs/yoodli).",
          ],
        },
        { p: "Those comparison pages use only what each company published on its own site on 25 November 2026. They do not rank a winner." },
      ],
    },
    {
      heading: "Use cases and industry pages",
      blocks: [
        {
          ul: [
            "[Alarm monitoring call center training](/use-cases/alarm-monitoring): operator calls, false alarms, dispatch decisions and contract objections, using the persona wizard.",
            "[911 dispatcher call-taking practice](/use-cases/911-dispatch): emergency-style call-taking practice. Grades are coaching feedback, not certification.",
            "Industry pages already live: [insurance](/for/insurance), [solar](/for/solar), [staffing](/for/staffing), [home services](/for/home-services), and [SaaS SDR](/for/saas-sdr).",
            "Try a single call: [dealership](/try/dealership), [real estate](/try/real-estate), [staffing](/try/staffing), or [insurance](/try/insurance).",
          ],
        },
        { p: "The [persona library](/library) lists the built-in buyers. Custom alarm or 911 scenarios are built in the wizard after you sign up." },
      ],
    },
    {
      heading: "How to start",
      blocks: [
        { p: "Create a free account with no card, pick a persona, and run a text call in minutes. Voice needs a microphone. Teams that want a walkthrough can [book a demo](/demo)." },
        { p: "[Start free, no card](/register?src=ai-sales-roleplay) · [See pricing](/pricing)" },
      ],
    },
  ],
  faq: [
    {
      q: "What is AI sales roleplay software?",
      a: "It is software that lets a rep practice a sales or service call against an AI buyer, then get scored. Call Trainer adds a live coach during the call and a debrief that quotes the transcript.",
      ld: "It is software that lets a rep practice a sales or service call against an AI buyer, then get scored. Call Trainer adds a live coach during the call and a debrief that quotes the transcript.",
    },
    {
      q: "Can I start Call Trainer without a demo?",
      a: "Yes. You can start the Free plan with no card, or go straight to Pro. Team is self-serve on [/pricing](/pricing). Teams that want a walkthrough can also [book a demo](/demo).",
      ld: "Yes. You can start the Free plan with no card, or go straight to Pro. Team is self-serve on https://calltrainer.tech/pricing. Teams that want a walkthrough can also book a demo at https://calltrainer.tech/demo.",
    },
    {
      q: "How is Call Trainer different from a general speaking coach?",
      a: "Call Trainer is built for sales and service calls: objection handling, a live coach on the turn, and a graded debrief. A broader speaking coach may also cover interviews, pitches and public speaking. See [Yoodli alternative](/alternatives/yoodli).",
      ld: "Call Trainer is built for sales and service calls: objection handling, a live coach on the turn, and a graded debrief. A broader speaking coach may also cover interviews, pitches and public speaking. See https://calltrainer.tech/alternatives/yoodli.",
    },
    {
      q: "Where are the Hyperbound and Yoodli alternative pages?",
      a: "See [Hyperbound alternative](/alternatives/hyperbound) and [Yoodli alternative](/alternatives/yoodli). The fair comparison hub is [/alternatives](/alternatives).",
      ld: "See https://calltrainer.tech/alternatives/hyperbound and https://calltrainer.tech/alternatives/yoodli. The fair comparison hub is https://calltrainer.tech/alternatives.",
    },
    {
      q: "Can I train alarm monitoring operators or 911 call-takers?",
      a: "Yes, as practice. Build the caller in the persona wizard after you sign up. See [alarm monitoring](/use-cases/alarm-monitoring) and [911 dispatch](/use-cases/911-dispatch). Those pages are not certified training programs.",
      ld: "Yes, as practice. Build the caller in the persona wizard after you sign up. See https://calltrainer.tech/use-cases/alarm-monitoring and https://calltrainer.tech/use-cases/911-dispatch. Those pages are not certified training programs.",
    },
  ],
};

export const ALT_HYPERBOUND_PAGE: ComparePageCopy = {
  kind: "alt",
  path: "/alternatives/hyperbound",
  crumb: "Hyperbound alternative",
  title: "Hyperbound Alternative for Small Sales Teams | Call Trainer",
  description:
    "A Hyperbound alternative you can start in minutes. Self-serve AI sales roleplay with live coaching, published prices, and a free plan. No enterprise demo required.",
  h1: "A Hyperbound alternative you can start in minutes",
  subhead:
    "Hyperbound is an AI sales roleplay platform whose paid plans, on its public pricing page, start with a demo. Call Trainer is self-serve call practice for individuals and small sales teams.",
  src: "alternatives-hyperbound",
  sections: [
    {
      blocks: [
        { p: "People searching for a Hyperbound alternative usually want AI roleplay of sales calls without an enterprise buying process. This page explains the fit, based on each company's public pages as of 25 November 2026. It is not a paid review, and it does not name a winner. For a line-by-line table, use [Call Trainer vs Hyperbound](/vs/hyperbound)." },
        { p: "Sources checked that day: [Hyperbound home](https://www.hyperbound.ai/), [Hyperbound pricing](https://www.hyperbound.ai/pricing), [Call Trainer home](https://calltrainer.tech/), and [Call Trainer pricing](https://calltrainer.tech/pricing)." },
      ],
    },
    {
      heading: "What each product is for",
      blocks: [
        { p: "Hyperbound describes itself as an AI sales roleplay and coaching platform. Its pricing page groups the product into Free, Practice and Perform. Practice lists AI sales roleplays, AI buyer bot customization, custom scorecards and custom onboarding. Perform adds real call scoring, deal coaching and conversation intelligence. Practice and Perform are presented as enterprise plans, each with a \"Book a demo\" CTA. A public monthly dollar amount was not shown for those paid plans on the page we loaded." },
        { p: "Call Trainer describes itself as hosted AI sales call practice with no setup. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. Hosted plans are published on the pricing page. You can start Free with no card, or start Pro or Team self-serve. Self-hosting stays free under the MIT license." },
      ],
    },
    {
      heading: "Buying motion and published prices",
      blocks: [
        {
          table: {
            head: ["Topic", "Call Trainer", "Hyperbound"],
            rows: [
              ["How paid plans start", "Self-serve on [/pricing](/pricing), or a [demo](/demo) if you want a walkthrough", "Practice and Perform are enterprise plans with \"Book a demo\" on [hyperbound.ai/pricing](https://www.hyperbound.ai/pricing)"],
              ["Free starting point", "Free plan, $0, no card, 10 voice minutes a month, unlimited text practice", "A Free plan with 45 prebuilt AI roleplays and prebuilt example scorecards, with a path to try a free roleplay"],
              ["Published paid price", "Pro, $29 a month or $290 a year. Team, $59 per seat per month or $590 per seat per year, 3-seat minimum", "Not shown as a public monthly dollar amount on the page we loaded. The FAQ says pricing is per user, with custom pricing available"],
              ["Live coach on the practice call", "Yes, a coach rail only the rep can see", "Practice lists custom AI coaching. This page does not claim how that feels in a session beyond the public list"],
              ["Real customer-call scoring", "Not on the public Call Trainer site. Practice calls are scored", "Listed on Perform, with conversation intelligence"],
            ],
          },
        },
        { p: "We do not invent a Hyperbound contract price. Recheck both sites before you buy." },
      ],
    },
    {
      heading: "Who each one may fit",
      blocks: [
        { p: "Hyperbound may fit a sales team that wants roleplay plus, on Perform, real-call scoring and CRM-connected coaching, and that is ready to book a demo for a paid plan. That is how the public pricing page is set up." },
        { p: "Call Trainer may fit a manager or individual who wants a published price, a first practice call the same day, unlimited text practice, and a live in-call coach. Small sales teams can start Team without a custom quote." },
        { p: "Some teams will want to try both. Start on Call Trainer Free, and try Hyperbound's public free roleplay on its own terms." },
      ],
    },
    {
      heading: "What this page does not claim",
      blocks: [
        { p: "We do not have Hyperbound's quoted enterprise price, implementation time or customer results. We do not cite review counts or logos. Feature lists change. Recheck both sites before you buy." },
      ],
    },
  ],
  faq: [
    {
      q: "Is Call Trainer a Hyperbound alternative?",
      a: "Both offer AI sales roleplay. Call Trainer is self-serve with published prices and a live coach on the practice call. Hyperbound's paid plans, on its public pricing page, start with a demo and include a broader Perform suite. See [Call Trainer vs Hyperbound](/vs/hyperbound) for the comparison table.",
      ld: "Both offer AI sales roleplay. Call Trainer is self-serve with published prices and a live coach on the practice call. Hyperbound's paid plans, on its public pricing page, start with a demo and include a broader Perform suite. See https://calltrainer.tech/vs/hyperbound for the comparison table.",
    },
    {
      q: "Does Hyperbound publish a paid monthly price?",
      a: "On 25 November 2026, [Hyperbound's pricing page](https://www.hyperbound.ai/pricing) listed Free, then Practice and Perform as enterprise plans with a \"Book a demo\" CTA. A public dollar amount for those paid plans was not on the page we loaded.",
      ld: "On 25 November 2026, Hyperbound's pricing page listed Free, then Practice and Perform as enterprise plans with a Book a demo CTA. A public dollar amount for those paid plans was not on the page we loaded.",
    },
    {
      q: "Can I start Call Trainer without a demo?",
      a: "Yes. Free is $0, no card. You can also start Pro or Team from [/pricing](/pricing). Teams that want a walkthrough can [book a demo](/demo).",
      ld: "Yes. Free is $0, no card. You can also start Pro or Team from https://calltrainer.tech/pricing. Teams that want a walkthrough can book a demo at https://calltrainer.tech/demo.",
    },
    {
      q: "Does Call Trainer score live customer calls?",
      a: "The public Call Trainer site describes scoring for practice calls. It does not describe a live-call recording or conversation intelligence product. Hyperbound's Perform plan lists real call scoring and conversation intelligence.",
      ld: "The public Call Trainer site describes scoring for practice calls. It does not describe a live-call recording or conversation intelligence product. Hyperbound's Perform plan lists real call scoring and conversation intelligence.",
    },
    {
      q: "How much is Call Trainer?",
      a: "Free is $0. Pro is $29 a month or $290 a year. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on [/pricing](/pricing).",
      ld: "Free is $0. Pro is $29 a month or $290 a year. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum. Details are on https://calltrainer.tech/pricing.",
    },
    {
      q: "What if I already use Hyperbound?",
      a: "You can still try Call Trainer on Free and see whether the live coach and transcript-quoted debrief are useful next to the tools you have. We will not tell you to rip anything out.",
      ld: "You can still try Call Trainer on Free and see whether the live coach and transcript-quoted debrief are useful next to the tools you have. We will not tell you to rip anything out.",
    },
  ],
};

export const ALT_YOODLI_PAGE: ComparePageCopy = {
  kind: "alt",
  path: "/alternatives/yoodli",
  crumb: "Yoodli alternative",
  title: "Yoodli Alternative for Sales Call Practice | Call Trainer",
  description:
    "A Yoodli alternative built for sales calls and call centers. Live coaching, transcript-quoted grading, and a published Team plan you can start without a demo.",
  h1: "A Yoodli alternative built for sales calls",
  subhead:
    "Yoodli covers sales and a wider set of speaking practice. Call Trainer is hosted call practice for sales teams and call centers, with a Team plan you can start without a demo.",
  src: "alternatives-yoodli",
  sections: [
    {
      blocks: [
        { p: "People searching for a Yoodli alternative often want roleplay that is specific to sales calls or call-center work, and a team plan they can start without booking a demo. This page explains the fit, based on each company's public pages as of 25 November 2026. It is not a paid review, and it does not name a winner. For a line-by-line table, use [Call Trainer vs Yoodli](/vs/yoodli)." },
        { p: "Sources checked that day: [Yoodli Roleplays](https://yoodli.ai/platform/roleplays), [Yoodli sales training](https://yoodli.ai/use-cases/sales-training), [Yoodli pricing](https://yoodli.ai/pricing), [Call Trainer home](https://calltrainer.tech/), and [Call Trainer pricing](https://calltrainer.tech/pricing)." },
      ],
    },
    {
      heading: "What each product is for",
      blocks: [
        { p: "Yoodli describes Roleplays as AI tutors, practice and certification. Learners can practice by video, chat or avatar, and be scored against a rubric. The sales training page talks about discovery, demos, objection handling and price negotiation. Individual plans also cover interview prep, public speaking and pitch practice. That is a broader human-skills platform, not only sales calls." },
        { p: "Call Trainer describes itself as hosted AI sales call practice with no setup. You talk or type with an AI buyer, get a live coach on the call, and finish with a graded debrief that quotes your transcript. The live site has industry `/for` and `/try` pages for specific call types, and a [persona library](/library) of sales and service jobs. Team includes a manager view and assignments, published on the pricing page." },
      ],
    },
    {
      heading: "Pricing, as published on 25 November 2026",
      blocks: [
        {
          table: {
            head: ["Topic", "Call Trainer", "Yoodli"],
            rows: [
              ["Free starting point", "Free plan, $0, no card, 10 voice minutes a month, unlimited text practice", "Individuals can start free. The pricing FAQ says the Starter plan includes 5 lifetime sessions"],
              ["Individual paid plan", "Pro, $29 a month or $290 a year, 200 voice minutes a month", "The pricing FAQ says Pro is $8/month billed annually, and Advanced is $20/month billed annually. We did not infer a monthly card price from other labels on the page"],
              ["Team plan", "Team, $59 per seat per month or $590 per seat per year, 3-seat minimum, published on [/pricing](/pricing)", "Business is per seat, billed annually, with a \"Get a Demo\" CTA. No Business dollar amount was shown on the page we loaded"],
              ["Focus", "Sales and service calls, including call-center style practice you build in the wizard", "Sales training plus interviews, public speaking, pitch practice, enablement and L&D"],
            ],
          },
        },
        { p: "Both products let an individual start free. For teams, Call Trainer publishes a Team price on the page. Yoodli's Business plan, on the public pricing page, starts with a demo." },
      ],
    },
    {
      heading: "Who each one may fit",
      blocks: [
        { p: "Yoodli may fit an individual who wants speaking, interview or pitch practice, or an enablement team that wants tutors, certifications and a broader human-skills platform, and that is ready to talk about a Business plan. That is how the public pages present it." },
        { p: "Call Trainer may fit a sales manager, SDR lead, call-center trainer or individual seller who wants call practice first, a published Team or Pro price, a live coach on the call, and a first practice session the same day." },
        { p: "If you need video presence, a buying committee or screen-share demos, read Yoodli's Roleplays page carefully. Call Trainer's public site is about the call itself: talk or type, get coached, read a debrief." },
      ],
    },
    {
      heading: "What this page does not claim",
      blocks: [
        { p: "We do not invent a Yoodli Business price. We do not cite review counts, customer logos or testimonials. Recheck both sites before you buy." },
      ],
    },
  ],
  faq: [
    {
      q: "Is Call Trainer a Yoodli alternative?",
      a: "Both offer AI roleplay. Yoodli covers sales and a wider set of speaking practice. Call Trainer is built for sales and service calls, with a live in-call coach and a published Team plan. See [Call Trainer vs Yoodli](/vs/yoodli).",
      ld: "Both offer AI roleplay. Yoodli covers sales and a wider set of speaking practice. Call Trainer is built for sales and service calls, with a live in-call coach and a published Team plan. See https://calltrainer.tech/vs/yoodli.",
    },
    {
      q: "Does Yoodli publish a Business price on the page?",
      a: "On 25 November 2026, [Yoodli's pricing page](https://yoodli.ai/pricing) described Business as per-seat, billed annually, with a \"Get a Demo\" CTA. No Business dollar amount was shown on the page we loaded.",
      ld: "On 25 November 2026, Yoodli's pricing page described Business as per-seat, billed annually, with a Get a Demo CTA. No Business dollar amount was shown on the page we loaded.",
    },
    {
      q: "What individual Yoodli prices were on the page?",
      a: "The pricing FAQ loaded on 25 November 2026 states that Pro is $8/month billed annually and Advanced is $20/month billed annually. Starter is described as 5 lifetime sessions.",
      ld: "The pricing FAQ loaded on 25 November 2026 states that Pro is $8/month billed annually and Advanced is $20/month billed annually. Starter is described as 5 lifetime sessions.",
    },
    {
      q: "Can a Call Trainer team start without a demo?",
      a: "Yes. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum, on [/pricing](/pricing). You can also start Free with no card. A [demo](/demo) is optional.",
      ld: "Yes. Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum, on https://calltrainer.tech/pricing. You can also start Free with no card. A demo at https://calltrainer.tech/demo is optional.",
    },
    {
      q: "Is Call Trainer only for sales?",
      a: "The live marketing site is focused on call practice, especially sales calls. You can also build service, alarm-monitoring or dispatcher-style callers in the persona wizard. See [alarm monitoring](/use-cases/alarm-monitoring) and [911 dispatch](/use-cases/911-dispatch).",
      ld: "The live marketing site is focused on call practice, especially sales calls. You can also build service, alarm-monitoring or dispatcher-style callers in the persona wizard. See https://calltrainer.tech/use-cases/alarm-monitoring and https://calltrainer.tech/use-cases/911-dispatch.",
    },
    {
      q: "Can I try both?",
      a: "Yes. Call Trainer Free is $0, no card. Yoodli's pricing page says individuals can get started for free, with a Starter plan of 5 lifetime sessions described in its FAQ. There is no harm in trying both.",
      ld: "Yes. Call Trainer Free is $0, no card. Yoodli's pricing page says individuals can get started for free, with a Starter plan of 5 lifetime sessions described in its FAQ. There is no harm in trying both.",
    },
  ],
};

const USE_CASE_PARENT = { name: "AI sales roleplay", path: ROLEPLAY_HUB_PATH } as const;

export const USE_ALARM_PAGE: ComparePageCopy = {
  kind: "topic",
  path: "/use-cases/alarm-monitoring",
  crumb: "Alarm monitoring",
  parent: USE_CASE_PARENT,
  title: "Alarm Monitoring Call Center Training | Call Trainer",
  description:
    "Practice alarm monitoring operator calls: false alarms, dispatch decisions and contract objections. Live coaching and graded debriefs. Start free, no card.",
  h1: "Practice the alarm monitoring calls that stall the night shift",
  subhead:
    "Build the subscriber, the false-alarm caller or the contract objector in the persona wizard. Then rehearse voice or text with a live coach and a debrief that quotes the transcript.",
  src: "use-alarm-monitoring",
  sections: [
    {
      blocks: [
        { p: "Alarm monitoring centers train operators on calls that are hard to role-play on a live line: a panicked subscriber, a false alarm that should not dispatch, a permit question, or a customer who wants to cancel the monitoring contract. Call Trainer lets a trainer or operator practice those conversations against an AI caller, with coaching on the turn and a grade after hang-up." },
        { p: "The built-in [persona library](/library) today is sales and service jobs. There is no reviewed alarm-monitoring pack in that catalog. You build the operator-side caller from your own scripts, a pasted call or CRM notes in the persona wizard after you sign up. Related practice already in the library includes [home services](/for/home-services) renewals and [insurance](/for/insurance) policyholder calls." },
      ],
    },
    {
      heading: "Calls you can rehearse",
      blocks: [
        {
          ul: [
            "False alarms: verify the event, decide whether to dispatch, and keep the subscriber calm without inventing facts.",
            "Dispatch decisions: collect location, premise details and a callback, and hand off cleanly.",
            "Contract objections: a subscriber who wants to cancel, freeze or shop the monitoring rate.",
            "After-hours tone: short questions, no filler, no over-promising a response time you cannot keep.",
          ],
        },
        { p: "Put those details in the persona: opening line, objections, a numbered talk track and a rubric. The live coach scores the turn against that rubric. The debrief quotes the transcript, so a trainer can see the exact line where the operator guessed or skipped a verify step." },
      ],
    },
    {
      heading: "How a center uses it",
      blocks: [
        { p: "Start Free with no card and run text practice while you draft the first persona. Voice practice uses the Free plan's 10 voice minutes a month, then Pro at $29 a month or Team at $59 per seat per month (3-seat minimum). Team adds a manager view, assignments and a coaching queue. Figures are on [/pricing](/pricing)." },
        {
          ul: [
            "New operators practice before they sit a live console.",
            "Trainers assign a false-alarm persona and review the quoted debrief instead of shadowing every night.",
            "Contract teams rehearse cancellation and renewal objections without putting a real subscriber on the line.",
          ],
        },
        { p: "This is practice, not a UL certificate or an AHJ approval. Follow your center's written procedures. The AI caller will only know what you put in the persona." },
      ],
    },
    {
      heading: "Start a practice session",
      blocks: [
        { p: "Create a free account, open the persona wizard, and paste an operator script or a redacted call. Then run a text call to check the objections, or a voice call if you have a mic. Teams that want a walkthrough can [book a demo](/demo)." },
        { p: "See also [AI sales roleplay software](/ai-sales-roleplay) and [911 dispatcher practice](/use-cases/911-dispatch)." },
        { p: "[Start free, no card](/register?src=use-alarm-monitoring) · [See pricing](/pricing)" },
      ],
    },
  ],
  faq: [
    {
      q: "Do you ship alarm monitoring personas in the library?",
      a: "Not today. The built-in library is sales and service jobs. You build alarm-monitoring callers in the persona wizard from your scripts or a pasted call after you sign up.",
      ld: "Not today. The built-in library is sales and service jobs. You build alarm-monitoring callers in the persona wizard from your scripts or a pasted call after you sign up.",
    },
    {
      q: "Can we practice false alarms and dispatch decisions?",
      a: "Yes. Put the verify steps, dispatch rules and objections into the persona. The live coach and the debrief score the call against that rubric, with quotes from the transcript.",
      ld: "Yes. Put the verify steps, dispatch rules and objections into the persona. The live coach and the debrief score the call against that rubric, with quotes from the transcript.",
    },
    {
      q: "Can a whole night shift use it?",
      a: "Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum, on [/pricing](/pricing). Managers get assignments and a coaching queue. You can also start Free with no card.",
      ld: "Team is $59 per seat per month or $590 per seat per year, with a 3-seat minimum, on https://calltrainer.tech/pricing. Managers get assignments and a coaching queue. You can also start Free with no card.",
    },
    {
      q: "Do I need a card to start?",
      a: "No. Free is $0, no card, with 10 voice minutes a month and unlimited text practice.",
      ld: "No. Free is $0, no card, with 10 voice minutes a month and unlimited text practice.",
    },
    {
      q: "Is this only for sales teams?",
      a: "No. Call Trainer is hosted call practice. Sales is the default library. Alarm monitoring, service and dispatcher-style calls are practiced with custom personas. See [AI sales roleplay software](/ai-sales-roleplay).",
      ld: "No. Call Trainer is hosted call practice. Sales is the default library. Alarm monitoring, service and dispatcher-style calls are practiced with custom personas. See https://calltrainer.tech/ai-sales-roleplay.",
    },
  ],
};

export const USE_911_PAGE: ComparePageCopy = {
  kind: "topic",
  path: "/use-cases/911-dispatch",
  crumb: "911 dispatch",
  parent: USE_CASE_PARENT,
  title: "911 Dispatcher Call-Taking Practice | Call Trainer",
  description:
    "Practice 911 call-taking with AI callers you build yourself. Live coaching and transcript-quoted debriefs. Not certification. Start free, no card.",
  h1: "Practice 911 call-taking before the next live line",
  subhead:
    "Rehearse location, nature of the call and keep-them-talking against an AI caller. Grades are coaching feedback, not certification, and Call Trainer is not affiliated with APCO, NENA, NFPA or the AHA.",
  src: "use-911-dispatch",
  sections: [
    {
      blocks: [
        { p: "New call-takers cannot practice a cardiac arrest or a highway pile-up on a real 911 line. Call Trainer lets a training officer or a trainee build those callers in the persona wizard, then run voice or text practice with a live coach and a debrief that quotes the transcript." },
        { p: "This page is about practice on Call Trainer at calltrainer.tech. It is not a certified 911 training program, an approved academy course or a protocol vendor. Call Trainer is an independent tool, not affiliated with, endorsed by or certified by APCO, NENA, NFPA, the AHA or any protocol vendor. Rubrics you write can reference your center's procedures. Grades are coaching feedback, not certification." },
      ],
    },
    {
      heading: "What you can practice",
      blocks: [
        {
          ul: [
            "Call-taking: location, callback, nature of the emergency, and keeping the caller talking.",
            "Medical, fire and law-enforcement openings you paste from your own training scripts.",
            "High-stress callers: shouting, incomplete address, language barriers you describe in the persona.",
            "Transfer and hold discipline: what the trainee must say before they leave a line.",
          ],
        },
        { p: "The built-in [persona library](/library) today is sales and service jobs. There is no reviewed 911 pack in that catalog. You build the caller from a training outline or a redacted tape after you sign up. Related reading: [alarm monitoring](/use-cases/alarm-monitoring) for central-station practice, and [AI sales roleplay software](/ai-sales-roleplay) for how the coach and debrief work." },
      ],
    },
    {
      heading: "How grading works on these calls",
      blocks: [
        { p: "You define the rubric: opening, location, nature, instructions, professionalism. The live coach estimates coverage on each turn. After the call, every score that survives is backed by a quote from the transcript. A training officer can retry from a chosen turn." },
        { p: "Do not treat a score as proof that a trainee meets APCO, NENA, NFPA, AHA or state POST standards. Those bodies do not certify this product. Follow your agency's training plan and your state's rules." },
      ],
    },
    {
      heading: "How a center or academy starts",
      blocks: [
        { p: "Create a free account with no card and run a text call while you draft the first persona. Voice uses the Free plan's 10 minutes a month, then Pro at $29 a month or Team at $59 per seat per month (3-seat minimum). Team adds assignments and a coaching queue. Figures are on [/pricing](/pricing)." },
        { p: "Agencies that want a walkthrough of Team, not a self-serve start, can [book a demo](/demo). Individual trainees can still start Free today." },
        { p: "[Start free, no card](/register?src=use-911-dispatch) · [See pricing](/pricing)" },
      ],
    },
  ],
  faq: [
    {
      q: "Is this certified 911 training?",
      a: "No. Call Trainer is an independent practice tool, not affiliated with, endorsed by or certified by APCO, NENA, NFPA, the AHA or any protocol vendor. Grades are coaching feedback, not certification.",
      ld: "No. Call Trainer is an independent practice tool, not affiliated with, endorsed by or certified by APCO, NENA, NFPA, the AHA or any protocol vendor. Grades are coaching feedback, not certification.",
    },
    {
      q: "Do you have a 911 persona pack in the library?",
      a: "Not in the built-in catalog on this site. You build call-taker scenarios in the persona wizard from your own scripts or a redacted call after you sign up.",
      ld: "Not in the built-in catalog on this site. You build call-taker scenarios in the persona wizard from your own scripts or a redacted call after you sign up.",
    },
    {
      q: "Do debriefs certify APCO or NENA standards?",
      a: "No. Debriefs score the rubric you put on the persona and quote the transcript. They do not certify alignment with APCO, NENA, NFPA or AHA standards.",
      ld: "No. Debriefs score the rubric you put on the persona and quote the transcript. They do not certify alignment with APCO, NENA, NFPA or AHA standards.",
    },
    {
      q: "Can a PSAP start without a demo?",
      a: "Yes. You can start Free with no card, or start Team from [/pricing](/pricing). A [demo](/demo) is available if you want a walkthrough.",
      ld: "Yes. You can start Free with no card, or start Team from https://calltrainer.tech/pricing. A demo at https://calltrainer.tech/demo is available if you want a walkthrough.",
    },
    {
      q: "Can we practice medical, fire and police call types?",
      a: "Yes, if you put those openings, questions and objections into the persona. The product will not invent a protocol your center does not use.",
      ld: "Yes, if you put those openings, questions and objections into the persona. The product will not invent a protocol your center does not use.",
    },
  ],
};

export const SEO_LANDING_PAGES: readonly ComparePageCopy[] = [
  ROLEPLAY_HUB_PAGE,
  ALT_HYPERBOUND_PAGE,
  ALT_YOODLI_PAGE,
  USE_ALARM_PAGE,
  USE_911_PAGE,
];
