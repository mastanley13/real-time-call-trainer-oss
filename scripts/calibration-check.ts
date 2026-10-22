/**
 * Sanity check for heuristic grading calibration.
 * Run: npx tsx --conditions=react-server scripts/calibration-check.ts
 * (the condition lets the `server-only` import resolve outside Next.js)
 */
import { gradeHeuristically, type Turn } from "../src/lib/grader";
import { BUILT_IN_SCENARIOS } from "../src/lib/scenarios";
import { goalStatusOf } from "../src/lib/grader-types";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;

const offersSlot: Turn[] = [
  { role: "assistant", text: scenario.aiPersona.openingLine },
  { role: "user", text: "Thanks for calling, this is Sam. How can I help you today?" },
  { role: "assistant", text: "My water heater is leaking in the garage." },
  { role: "user", text: "I'm sorry to hear that. Is the water shut off, and how old is the unit?" },
  { role: "assistant", text: "It's off. About twelve years old." },
  { role: "user", text: "Our diagnostic fee is $89, applied to the repair. I have a technician available tomorrow between 2 and 4 pm, how about that window?" },
  { role: "assistant", text: "Let me think about it." },
];
const noSlot: Turn[] = [offersSlot[0], offersSlot[1], offersSlot[2], { role: "user", text: "Okay, thanks. Call us back." }];

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

const a = gradeHeuristically(scenario, offersSlot);
const b = gradeHeuristically(scenario, noSlot);
const closeA = a.criteria.find((c) => c.id === "close")!;
const closeB = b.criteria.find((c) => c.id === "close")!;
console.log(`close: offered-slot=${closeA.score} no-slot=${closeB.score}; overall ${a.overallScore} vs ${b.overallScore}; goal=${goalStatusOf(a)}`);

check("offering a slot gets partial booking credit (>=55)", closeA.score >= 55);
check("offering a slot beats not offering one", closeA.score > closeB.score);
check("unconfirmed slot is not full credit (<80)", closeA.score < 80);
check("goal is at least partial when a slot was offered", goalStatusOf(a) !== "not_achieved");
check("heuristic stamps graderVersion", a.graderVersion === "heuristic-v2");

process.exit(results.every(([, ok]) => ok) ? 0 : 1);
