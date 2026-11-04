# Icons

One icon set for the whole app: **lucide-react**, stroke width `1.75` (see AGENTS.md), `aria-hidden` when the icon sits next to a text label, `aria-label` on the control when it does not. Icons are literal: they name the object or action. If no literal icon fits, use a text label and no icon.

`tests/icons.test.ts` fails if any file under `src` imports a generic AI glyph from lucide-react (Sparkles, Wand*, Bot*, Brain*, Star*), imports another icon package, or uses emoji or glyphs as icons.

## Decision

We compared six sets for coverage of our actions, visual consistency and cost in Next.js 15. We kept Lucide.

| Set | Style | Stroke width | Covers our actions | Next 15 `optimizePackageImports` default | Server components | Switch cost |
|---|---|---|---|---|---|---|
| **Lucide** (current) | 24 px outline, round caps, ~1,600 icons, ISC | Any value | All, including ClipboardCheck, MessageSquare, BookOpen, PhoneOff, MicOff | Yes | Works as is | None |
| Phosphor (regular, duotone) | 6 fixed weights, ~1,500 icons each, MIT | Fixed per weight, so 1.75 cannot carry over | Most. No exact ClipboardCheck or square MessageSquare | No | Needs `@phosphor-icons/react/dist/ssr` in server components | 33 files, 78 icons |
| Tabler | 24 px outline, ~5,900 icons, MIT | Any value | All | Yes | Works as is | 33 files, 78 icons |
| Heroicons | Outline 1.5 and solid, ~320 icons, MIT | Tuned for 1.5 | Gaps: no mic off, no end call, no clipboard check | Yes (`20/solid`, `24/solid`, `24/outline`) | Works as is | 33 files, plus gaps |
| Radix Icons | 15 px filled, ~300 icons, MIT | No | Gaps for calls and grading | No | Works as is | 33 files, plus gaps |
| Remix Icon | 24 px line and fill pairs, ~3,000 icons, Apache-2.0 | No | Most | No | Works as is | 33 files, 78 icons |

Why Lucide:

- It already covers every action below with a literal icon, so a switch would buy no coverage.
- Stroke width is a prop, which the 1.75 rule depends on. Phosphor, Radix and Remix have fixed weights.
- It is on Next's default `optimizePackageImports` list (checked in `node_modules/next/dist/server/config.js`), so named imports compile to one module per icon with no config. Phosphor, Remix and Radix are not on that list.
- No provider and no special server import path.
- Tabler is the only close equal. Moving 78 icons in 33 files to it would change nothing a rep can see.

We did not install any other set to measure it. Per-icon cost for all six is a few hundred bytes gzipped, so bundle size does not decide this.

## Use these icons for these actions

| Action or object | Icon | Label |
|---|---|---|
| Create persona | `UserPlus` | New persona |
| Persona library, persona collection | `BookOpen` (decision made: BookOpen, replaces IdCard) | Library |
| One persona | `UserRound` | Pick a persona |
| Draft with the wizard | `PenLine` | Draft persona |
| Model, provider, model chip | `Cpu` | Models |
| Start practice (opens the briefing) | `Phone` | Start practice |
| Start call, new call, practice tab | `PhoneCall` | Start call, New practice call, Practice |
| End call | `PhoneOff` | End & grade |
| Voice, mic | `Mic`, `MicOff` | Voice, Test mic, Mute, Unmute |
| Text mode | `Keyboard` | Text |
| Grading, debrief | `ClipboardCheck` | Post-call grading |
| Re-grade | `RefreshCw` | Re-grade |
| Assign a persona | `ClipboardPlus` | Assign persona |
| Assignments list | `ClipboardList` | Assignments |
| Coach feedback, coach cue | `MessageSquare` | Coach |
| Note | `MessageSquareText` | Add note |
| Team | `Users` | Team |
| Invite (when we add it) | `UserPlus`, or `Mail` for email invites | Invite members |
| Settings | `Settings` | Settings |
| Security, MFA | `ShieldCheck` | Security |
| Billing | `CreditCard` | Billing |
| Connection check | `Plug` | Check connection |
| Progress | `BarChart3` | Progress |
| Score went up | `TrendingUp` | |
| Coming soon on a plan | `Clock` | |
| Search | `Search` | |
| Run locally | `Terminal` | Run it locally |
| Loading | `Loader2` with `animate-spin` | |

Never use these to mean AI: Sparkles, Wand, WandSparkles, Bot, Brain, BrainCircuit, Star, Stars, robot heads or glowing shapes.

## Sizes

16 px inline and in buttons, 13 to 14 px in `btn-sm` and chips, 18 px in icon tiles and `btn-xl`, 17 px in the header icon buttons. Pick the size from the control the icon sits in, not per screen.
