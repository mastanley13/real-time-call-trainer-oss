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
  ["price", /\b(price|pricing|cost|costs|fee|fees|charge|charges|how much|quote|estimate|rate|rates|discount|\$\d+)\b|\$/i],
  ["availability", /\b(available|availability|appointment|schedule|scheduled|book|booking|today|tomorrow|this afternoon|this morning|window|come out|slot|when can|opening)\b/i],
  ["objection", /\b(understand|appreciate|hear you|totally get|value|guarantee|warranty|worth|compare|comparison|reason)\b/i],
  ["greeting", /^\s*(hi|hello|hey|good (morning|afternoon|evening)|thanks? (you )?for calling|thank you for calling)\b|\b(my name is|this is \w+)\b/i],
];

/** Sample replies that look like an answer to each intent. */
const SAMPLE_HINTS: Partial<Record<Intent, RegExp>> = {
  phone: /\d{3}[-. ]\d{4}/,
  address: /\b\d+ [A-Z][a-z]+ (court|ct|st|street|ave|avenue|road|rd|lane|ln|drive|dr|way|blvd)\b/i,
  price: /\b(cost|fee|price|\$|expensive|pay|quote|afford)\b/i,
  availability: /\b(today|tomorrow|afternoon|morning|works|schedule|show up|appointment|time)\b/i,
  objection: /\b(still|but|other|higher|budget|think|competitor|cheaper|too)\b/i,
  closing: /\b(thanks|thank you|great|sounds good|bye)\b/i,
};

const FALLBACK: Record<Intent, string> = {
  closing: "Okay, that works for me. Thank you, goodbye.",
  greeting: "Hi, thanks for picking up.",
  name: "",
  phone: "Sure, it's 555-0142.",
  address: "It's 42 Maple Court.",
  price: "Okay. Roughly what would the total come to?",
  availability: "That could work. What time were you thinking?",
  objection: "I hear you, but it still feels like a lot to me.",
};

export function detectIntents(text: string): Intent[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([i]) => i);
  // Closing and objection handling are whole-turn intents; data questions can stack.
  if (found.includes("closing") && !/\?/.test(text)) return ["closing"];
  return found.filter((i) => i !== "closing");
}

export function scriptedReply(scenario: Scenario, history: Turn[]): string {
  const lastUser = [...history].reverse().find((h) => h.role === "user")?.text ?? "";
  const said = new Set(history.filter((h) => h.role === "assistant").map((h) => h.text));
  const samples = scenario.sampleReplies.filter((s) => ![...said].some((r) => r.includes(s)));
  const take = (hint?: RegExp): string | undefined => (hint ? samples.find((s) => hint.test(s)) : undefined);

  const intents = detectIntents(lastUser);
  const parts: string[] = [];
  const push = (t: string | undefined) => t && !said.has(t) && !parts.includes(t) && parts.push(t);

  for (const i of ["address", "phone"] as const) if (intents.includes(i)) push(take(SAMPLE_HINTS[i]) ?? FALLBACK[i]);
  // Don't repeat the caller's name if a sample line already gave it.
  if (intents.includes("name") && !parts.some((p) => p.includes(scenario.aiPersona.name))) parts.unshift(`It's ${scenario.aiPersona.name}.`);
  if (parts.length === 0) {
    const topic = (["price", "availability", "objection", "closing"] as const).find((i) => intents.includes(i));
    if (topic) push(take(SAMPLE_HINTS[topic]) ?? FALLBACK[topic]);
  }
  if (parts.length === 0 && intents.includes("greeting") && history.filter((h) => h.role === "user").length <= 1) {
    push(FALLBACK.greeting);
    if (lastUser.includes("?")) push(samples[0]);
  }

  if (parts.length === 0) {
    // Nothing recognised: use an unused scripted line, or react to the question.
    const next = samples[0];
    push(next ?? (lastUser.includes("?") ? "Hmm, I'm not sure. What would you recommend?" : "Okay, go on."));
  }
  return parts.join(" ");
}
