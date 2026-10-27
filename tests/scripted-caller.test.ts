import { describe, expect, it } from "vitest";
import { BUILT_IN_SCENARIOS, type Scenario } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { detectIntents, scriptedReply } from "@/lib/scriptedCaller";

type Turn = { role: "user" | "assistant"; text: string };

const home = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const CONTACT_LINE = "Okay. My name is Dana Whitfield, 42 Maple Court. Number is 555-0142.";
const FEE_LINE = "What does a visit cost? Nobody mentioned a fee.";
/** The same persona with no scripted lines, so only the built-in fallbacks can answer. */
const bare: Scenario = { ...home, sampleReplies: [] };

const opening = (s: Scenario): Turn[] => [{ role: "assistant", text: s.aiPersona.openingLine }];
const ask = (s: Scenario, ...repLines: string[]): string => {
  const history = opening(s);
  let reply = "";
  for (const text of repLines) {
    history.push({ role: "user", text });
    reply = scriptedReply(s, history);
    history.push({ role: "assistant", text: reply });
  }
  return reply;
};

describe("detectIntents", () => {
  it.each([
    ["What's the best number to reach you?", "phone"],
    ["Can I grab a callback number?", "phone"],
    ["What's the service address?", "address"],
    ["Where are you located?", "address"],
    ["How much does the visit cost?", "price"],
    ["The fee is $89.", "price"],
    ["I have a technician available this afternoon.", "availability"],
    ["Can I get your name?", "name"],
    ["I understand, and it's worth comparing.", "objection"],
    ["Hi, this is Sam from Rapid Flow Plumbing.", "greeting"],
  ])("finds %j as %s", (text, intent) => {
    expect(detectIntents(text)).toContain(intent);
  });

  it("lets data questions stack", () => {
    expect(detectIntents("Can I get your name, your address and the best phone number?")).toEqual(expect.arrayContaining(["name", "address", "phone"]));
  });

  it("treats a closing statement as the whole turn", () => {
    expect(detectIntents("Great, you're booked for this afternoon. Goodbye!")).toEqual(["closing"]);
  });

  it("ignores closing words inside a question", () => {
    expect(detectIntents("To confirm, is 555-0142 the best number?")).not.toContain("closing");
    expect(detectIntents("To confirm, is 555-0142 the best number?")).toContain("phone");
  });

  it("finds nothing in small talk", () => {
    expect(detectIntents("Okay.")).toEqual([]);
  });
});

describe("scriptedReply", () => {
  it("answers a phone question with the scripted line that has the number", () => {
    expect(ask(home, "What's the best number to reach you?")).toBe(CONTACT_LINE);
  });

  it("answers an address question with the scripted line that has the address", () => {
    expect(ask(home, "What's the service address?")).toBe(CONTACT_LINE);
  });

  it("answers address and phone together without saying the line twice", () => {
    expect(ask(home, "What's the address, and the best callback number?")).toBe(CONTACT_LINE);
  });

  it("does not repeat the caller's name when the scripted line already gives it", () => {
    expect(ask(home, "Can I get your name and the best number for you?")).toBe(CONTACT_LINE);
  });

  it("gives the persona's name when asked for it alone", () => {
    expect(ask(home, "Can I get your name, please?")).toBe(`It's ${home.aiPersona.name}.`);
  });

  it("answers a price question with the scripted price line", () => {
    expect(ask(home, "Do you have questions about the price?")).toBe(FEE_LINE);
  });

  it("does not ask what it costs after the rep has named the price", () => {
    // The exact exchange from a demo call: the rep names the fee and a time in one turn.
    const reply = ask(
      home,
      "Thanks for calling Peak Plumbing, this is Sam. What's going on with the water heater?",
      "Got it. How old is the unit, and is the leak coming from the bottom of the tank or a pipe?",
      "I'm sorry you're dealing with this. Can I get your name, address and the best callback number?",
      "The diagnostic visit is $89 and it's credited toward the repair. I can get someone out this afternoon at 2.",
    );
    expect(reply).toBe("Alright, that works. Can you confirm someone will really show up this afternoon?");
    // A price named on its own gets a reaction, not the scripted fee question.
    expect(ask(home, "The visit is $89.")).not.toMatch(/\bcost\b.*\?|\bfee\b.*\?/i);
    expect(ask(bare, "It's 89 dollars for the visit.")).toBe("Okay, that sounds fair.");
    // Later turns don't bring the fee question back either.
    expect(ask(home, "The visit is $89.", "Okay.", "Got it.", "Right.", "Sure.")).not.toBe(FEE_LINE);
  });

  it("still raises the fee question when the price only came up as a topic", () => {
    expect(ask(home, "Before we book, any questions about pricing?")).toBe(FEE_LINE);
  });

  it("does not treat a budget, a limit or a discount as a quoted price", () => {
    expect(ask(home, "Are you looking to spend under $500?")).toBe(FEE_LINE);
    expect(ask(home, "I can take $20 off the visit.")).not.toBe("Okay, that sounds fair.");
  });

  it("keeps price objections and pushback after the rep quotes a price", () => {
    const persona = (id: string) => LIBRARY.find((s) => s.id === id)!;
    expect(ask(persona("home-services-pest-renewal"), "The rate is $129 per quarter, up from $119.")).toMatch(/why the price increase/i);
    expect(ask(persona("collections-first-past-due"), "The $389.00 payment due on the 3rd was missed, and with the $19.45 late fee that's $408.45 past due.")).toMatch(/late fee/i);
    expect(ask(persona("retail-tv-soundbar-upsell"), "I'd add our soundbar. It's $199.")).toMatch(/on top of the TV/i);
  });

  it("only holds back a cost question about the thing the rep priced", () => {
    // Every reply over a drained script, so a line counts as reachable wherever it lands.
    const replies = (s: Scenario, first: string) => {
      const history = opening(s);
      const out: string[] = [];
      for (const text of [first, "Okay.", "Got it.", "Right.", "Sure.", "Mm-hm.", "Go on.", "I see.", "Okay.", "Right."]) {
        history.push({ role: "user", text });
        const reply = scriptedReply(s, history);
        out.push(reply);
        history.push({ role: "assistant", text: reply });
      }
      return out.join("\n");
    };
    const persona = (id: string) => LIBRARY.find((s) => s.id === id)!;
    // A house price doesn't answer "what would my monthly payment be?", and a salary doesn't answer "how much runway?".
    expect(replies(persona("mortgage-first-time-buyer-preapproval"), "The home you liked is listed at $350,000.")).toMatch(/monthly payment/i);
    expect(replies(persona("recruiting-passive-candidate-cold-outreach"), "The base is $150,000 plus equity.")).toMatch(/runway/i);
    // But a priced visit is not asked about again, however long the call runs.
    expect(replies(home, "The diagnostic visit is $89.")).not.toContain(FEE_LINE);
  });

  it("greets back on the rep's first turn", () => {
    expect(ask(bare, "Hi, this is Sam from Rapid Flow Plumbing.")).toBe("Hi there.");
  });

  it("greets as the person who answered on outbound calls", () => {
    const cold: Scenario = { ...bare, callType: "cold" };
    expect(ask(cold, "Hi, this is Sam from Rapid Flow Plumbing.")).toBe("Hi. What can I do for you?");
    expect(ask({ ...home, callType: "cold" }, "Hi, this is Sam. Do you have a minute?")).toBe(`Hi. ${home.sampleReplies[0]}`);
  });

  it("does not treat a 'today' opener as a scheduling question", () => {
    expect(detectIntents("How can I help you today?")).not.toContain("availability");
    expect(detectIntents("Could we come by tomorrow at nine?")).toContain("availability");
    expect(ask(home, "How can I help you today?")).toBe(home.sampleReplies[0]);
  });

  it("repeats a number it already gave instead of inventing a new one", () => {
    const own: Scenario = { ...bare, sampleReplies: ["You can reach me at 312-555-0199."] };
    expect(ask(own, "What's the best number?", "Sorry, what was that number again?")).toBe("Same as before, it's 312-555-0199.");
  });

  it("moves on to the next unused scripted line when nothing is recognised", () => {
    expect(ask(home, "Okay.")).toBe(home.sampleReplies[0]);
    expect(ask(home, "Okay.", "Got it.")).toBe(home.sampleReplies[1]);
  });

  it("never repeats a line it has already said", () => {
    const history = opening(home);
    const said: string[] = [];
    const repLines = ["Okay.", "Got it.", "What's your number?", "How much would it cost?", "Right.", "And your number again?", "What's the address?", "Sure."];
    for (const text of repLines) {
      history.push({ role: "user", text });
      const reply = scriptedReply(home, history);
      if (reply) {
        expect(said).not.toContain(reply);
        said.push(reply);
      }
      history.push({ role: "assistant", text: reply });
    }
    // Every scripted line is used at most once.
    for (const line of home.sampleReplies) expect(said.filter((r) => r.includes(line)).length).toBeLessThanOrEqual(1);
  });

  it("repeats the address it already gave once the scripted line is used", () => {
    expect(ask(home, "What's your number?", "And what's the address?")).toBe("Same as before, it's 42 Maple Court.");
  });

  it("falls back to sensible stock lines with no scripted replies", () => {
    expect(ask(bare, "What's the best number to reach you?")).toBe("Sure, it's 555-0142.");
    expect(ask(bare, "What's the address?")).toBe("It's 42 Maple Court.");
    expect(ask(bare, "How much do you want to spend?")).toBe("Okay. Roughly what would the total come to?");
    expect(ask(bare, "We can come out this afternoon.")).toBe("That could work. What time were you thinking?");
    expect(ask(bare, "Thanks, you're booked. Goodbye.")).toBe("Okay, that works for me. Thank you, goodbye.");
    expect(ask(bare, "Okay.", "Is that a gas heater?")).toBe("Hmm, I'm not sure. What would you recommend?");
    expect(ask(bare, "Okay.")).toBe("Okay, go on.");
  });

  it("always returns a line, even after the script runs out", () => {
    const history = opening(bare);
    for (const text of ["Okay.", "Right.", "Sure.", "Fine.", "Got it.", "Mm-hm.", "Okay.", "What else?", "Anything?", "Really?", "And?"]) {
      history.push({ role: "user", text });
      const reply = scriptedReply(bare, history);
      expect(reply).not.toBe("");
      history.push({ role: "assistant", text: reply });
    }
  });
});
