import type { Scenario } from "./scenarios";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

type Intent = "closing" | "greeting" | "name" | "phone" | "address" | "price" | "availability" | "objection";

const PATTERNS: [Intent, RegExp][] = [
  ["closing", /\b(goodbye|bye|have a (good|great|nice)|anything else|you're all set|we'll see you|technician will|next steps|let me confirm|to confirm|confirm(ing)? (that|your|the|everything)|you're booked)\b/i],
  ["name", /\b(your|ur) (full |first |last )?name\b|who (am i|i'm) (speaking|talking)|(get|have|take) (a|your) name/i],
  ["phone", /\b(phone|number|call ?back|best way to reach|reach you|contact)\b/i],
  ["address", /\b(address|street|where are you located|where do you live|located|your location|zip)\b/i],
  ["price", /\b(price|pricing|cost|costs|fee|fees|charge|charges|how much|quote|estimate|rate|rates|discount|\$\d+)\b|\$|\b\d+(\.\d+)?\s?(dollars|bucks)\b/i],
  ["availability", /\b(available|availability|appointment|schedule|scheduled|book|booking|this afternoon|this morning|window|come out|slot|when can|opening)\b/i],
  ["objection", /\b(understand|appreciate|hear you|totally get|value|guarantee|warranty|worth|compare|comparison|reason)\b/i],
  ["greeting", /^\s*(hi|hello|hey|good (morning|afternoon|evening)|thanks? (you )?for calling|thank you for calling)\b|\b(my name is|this is \w+)\b/i],
];

/** Sample replies that look like an answer to each intent. */
const PHONE_RE = /(\(?\d{3}\)?[-. ]?)?\d{3}[-. ]\d{4}/;
const SAMPLE_HINTS: Partial<Record<Intent, RegExp>> = {
  phone: PHONE_RE,
  address: /\b\d+ [A-Z][a-z]+ (court|ct|st|street|ave|avenue|road|rd|lane|ln|drive|dr|way|blvd)\b/i,
  price: /\b(cost|fee|price|\$|expensive|pay|quote|afford)\b/i,
  availability: /\b(today|tomorrow|afternoon|morning|works|schedule|show up|appointment|time)\b/i,
  objection: /\b(still|but|other|higher|budget|think|competitor|cheaper|too)\b/i,
  closing: /\b(thanks|thank you|great|sounds good|bye)\b/i,
};

/** A rep sentence that quotes an amount ("$89", "89 dollars"); not a discount, a limit or a budget ("$20 off", "under $500"). */
const AMOUNT_RE = /\$\s?\d|\b\d+(\.\d+)?\s?(dollars|bucks)\b/i;
const NOT_A_QUOTE_RE = /\b(off|discount\w*|under|below|less than|more than|up to|at most|max(imum)?|budget\w*|spend\w*|sav(e|es|ing|ings)|cheaper)\b/i;
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+/);
const quotesPrice = (sentence: string) => AMOUNT_RE.test(sentence) && !NOT_A_QUOTE_RE.test(sentence);
/** A scripted line that asks for an amount ("What does a visit cost?"), as opposed to "how much runway" or a price objection. */
const ASKS_AMOUNT_RE =
  /\b(what (does|do|would|will|is|are|['’]s)\b[^?]*\b(cost|costs|fee|fees|price|pricing|charge|run)\b[^?]*\?|what would (i|we) (pay|be paying)\b[^?]*\?|how much (is|are|does|do|would|will)\b[^?]*\b(cost|costs|be|run|charge|pay)\b[^?]*\?|how much (is it|is that|would (it|that) be|will (it|that) be)\b[^?]*\?|\b(ballpark|price range|rough (number|idea|price))\b[^?]*\?)/i;
/** Pushback and follow-ups stay even when they mention cost: "Why the price increase?", "another two hundred on top". */
const REACTS_RE = /\b(why|on top|extra|another|more|increase|too (much|high|expensive)|but|instead|again)\b/i;
/** Words that say what was priced ("visit", "clients", "replacement"); units and price words don't. */
const NOT_A_SUBJECT = new Set(
  "what does would will that this with your have about much like just give tell need really actually usually something roughly ballpark number numbers answer straight cost costs price pricing charge total from there their they them then when where which month year week hour quarter each every dollar buck"
    .split(" "),
);
const subjectsOf = (text: string) =>
  new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.replace(/(ly|es|s)$/, "")).filter((w) => w.length >= 4 && !NOT_A_SUBJECT.has(w)));
const PRICE_HEARD = "Okay, that sounds fair.";

/** "Today" or "tomorrow" only means scheduling outside openers like "How can I help you today?". */
const DAY_WORD = /\b(today|tomorrow)\b/i;
const OPENER = /\b(help|how are|how's|calling|reach(ing)? out|speak|talk)\b/i;

/** Used once the script and the matching stock line are spent, so the caller never goes silent. */
const QUESTION_POOL = ["Hmm, I'm not sure. What would you recommend?", "Good question. What do you usually see?", "I'd have to think about that. What do you suggest?"];
const STATEMENT_POOL = ["Okay, go on.", "Right, I'm listening.", "Sure. What else?", "Okay. And then what?"];

const FALLBACK: Record<Intent, string> = {
  closing: "Okay, that works for me. Thank you, goodbye.",
  // The persona called in, so it is the rep who picked up. Outbound calls use a different line (see scriptedReply).
  greeting: "Hi there.",
  name: "",
  phone: "Sure, it's 555-0142.",
  address: "It's 42 Maple Court.",
  price: "Okay. Roughly what would the total come to?",
  availability: "That could work. What time were you thinking?",
  objection: "I hear you, but it still feels like a lot to me.",
};

export function detectIntents(text: string): Intent[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([i]) => i);
  if (!found.includes("availability") && DAY_WORD.test(text) && !OPENER.test(text)) found.push("availability");
  // Closing and objection handling are whole-turn intents; data questions can stack.
  if (found.includes("closing") && !/\?/.test(text)) return ["closing"];
  return found.filter((i) => i !== "closing");
}

export function scriptedReply(scenario: Scenario, history: Turn[]): string {
  const lastUser = [...history].reverse().find((h) => h.role === "user")?.text ?? "";
  const said = new Set(history.filter((h) => h.role === "assistant").map((h) => h.text));
  // A scripted "what does a visit cost?" is held back once the rep has quoted a price for the visit;
  // objections and questions about something else stay.
  const quoted = subjectsOf(history.filter((h) => h.role === "user").flatMap((h) => sentencesOf(h.text)).filter(quotesPrice).join(" "));
  const alreadyPriced = (line: string) => ASKS_AMOUNT_RE.test(line) && !REACTS_RE.test(line) && [...subjectsOf(line)].some((w) => quoted.has(w));
  const unsaid = (line: string) => ![...said].some((r) => r.includes(line));
  const samples = scenario.sampleReplies.filter((s) => unsaid(s) && !alreadyPriced(s));
  const take = (hint?: RegExp): string | undefined => (hint ? samples.find((s) => hint.test(s)) : undefined);

  const intents = detectIntents(lastUser);
  const parts: string[] = [];
  const push = (t: string | undefined) => t && !said.has(t) && !parts.includes(t) && parts.push(t);

  // Contact details: an unused scripted line, else repeat what the persona already said, else the stock line.
  const earlier = (i: "address" | "phone") => {
    for (const t of said) { const m = t.match(i === "phone" ? PHONE_RE : SAMPLE_HINTS.address!); if (m) return `Same as before, it's ${m[0]}.`; }
  };
  for (const i of ["address", "phone"] as const) if (intents.includes(i)) push(take(SAMPLE_HINTS[i]) ?? earlier(i) ?? FALLBACK[i]);
  // Don't repeat the caller's name if a sample line already gave it.
  if (intents.includes("name") && !parts.some((p) => p.includes(scenario.aiPersona.name))) parts.unshift(`It's ${scenario.aiPersona.name}.`);
  if (parts.length === 0) {
    // A quoted price gets a reaction, not a price question, and a time offered in the same turn comes first.
    const priceNamed = sentencesOf(lastUser).some(quotesPrice);
    const order: Intent[] = priceNamed ? ["availability", "price", "objection", "closing"] : ["price", "availability", "objection", "closing"];
    const topic = order.find((i) => intents.includes(i));
    // With no scripted price line left, the persona's own price objection beats agreeing.
    const priceObjection = () => scenario.objections.find((o) => o.type === "price" && unsaid(o.line) && !alreadyPriced(o.line))?.line;
    if (topic) push(take(SAMPLE_HINTS[topic]) ?? (topic === "price" && priceNamed ? priceObjection() ?? PRICE_HEARD : FALLBACK[topic]));
  }
  if (parts.length === 0 && intents.includes("greeting") && history.filter((h) => h.role === "user").length <= 1) {
    const answer = lastUser.includes("?") ? samples[0] : undefined;
    // On outbound calls the persona answered the phone, so it greets the rep back and asks what they want.
    push(scenario.callType === "inbound" ? FALLBACK.greeting : answer ? "Hi." : "Hi. What can I do for you?");
    push(answer);
  }

  // Nothing recognised: use an unused scripted line, or react to the question.
  const pool = lastUser.includes("?") ? QUESTION_POOL : STATEMENT_POOL;
  if (parts.length === 0) push(samples[0] ?? pool.find((t) => !said.has(t)));
  // Everything has been said once: repeating a neutral line beats going silent.
  if (parts.length === 0) parts.push(pool[history.length % pool.length]);
  return parts.join(" ");
}
