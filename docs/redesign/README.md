# UI council

Research for a full UI redesign of Real-Time Call Trainer, aimed at OpenAI's Codex open source fund and Codex for Open Source program.

## How it ran

1. **Brief.** [BRIEF.md](BRIEF.md) describes the app as it is today (screenshots in [current/](current/)), the two product needs (live coaching and scoring of active calls; a persona library for every sales job plus an AI persona wizard), the scoring rubric and the research tools.
2. **Design (50 Haiku 5.5 agents).** Each designer started from a different lens, studied the screenshots, researched Mobbin and the web with Firecrawl, and proposed a total UI redesign. All 50 are in [council/proposals/](council/proposals/).
3. **Peer cut (the same 50).** Each juror reviewed five proposals that were not its own and had to advance two or three, writing the case for and against each. The top 25 advanced. Reviews: [council/peer-reviews.json](council/peer-reviews.json).
4. **Board (5 Sonnet 5.5 agents).** Seats: product design, sales enablement, open-source and Codex fund reviewer, UX and accessibility, go-to-market. Each presented five finalists, then every seat scored all 25 on the rubric. [council/board-presentations.json](council/board-presentations.json), [council/board-scoresheets.json](council/board-scoresheets.json).
5. **Verdict.** The board chair's write-up and the full scoreboard are in [council/results.json](council/results.json).

## Rubric

| Key | Category | Scale |
|---|---|---|
| A | Look: user-friendly, modern, sleek, cutting edge | 1-10 |
| B | User experience as a whole | 1-10 |
| C | Unique design that still meets sales-training basics | 1-10 |
| D | Live call coaching and scoring | baseline: 5.0 = meets the standard |
| E | Persona library for all sales jobs + AI wizard | baseline: 5.0 = meets the standard |
| F1 | Viability as SaaS | 1-10, 5 neutral |
| F2 | Viability selling to entities | 1-10, 5 neutral |
| F3 | Not worth it at all | 1-10, lower is better |

Composite = mean of A, B, C, D, E, F1, F2 and (11 - F3), averaged over the five seats.

## Top five

| Rank | Design | Composite | Seats with it in their top 5 |
|---|---|---|---|
| 1 | P19 Live Coach Studio | 6.90 | 3 |
| 2 | P39 Flight Deck Cockpit | 6.87 | 5 |
| 3 | P47 Composed Coaching Console | 6.83 | 3 |
| 4 | P12 Film Room Sideline | 6.78 | 3 |
| 5 | P26 Copilot Rail Studio | 6.75 | 5 (first on four) |

Static mockups of each (live call, library and wizard, debrief, mobile) are in [artifact/designs/](artifact/designs/), and [artifact/index.html](artifact/index.html) is the comparison page.
