/**
 * Smoke test for the live coach (heuristic path) and the persona wizard (template path).
 * Run: npx tsx scripts/coach-smoke.ts
 *
 * LLM keys are cleared, so this exercises the no-key paths only. The modules
 * under test import "server-only", which throws outside Next.js; a no-op shim
 * is registered before they load (static imports would be hoisted above it).
 */
import Module from "node:module";

const localRequire = Module.createRequire(__filename);
const serverOnlyPath = localRequire.resolve("server-only");
localRequire.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as unknown as NodeJS.Module;

delete process.env.LLM_API_KEY;
delete process.env.OPENAI_API_KEY;

type Role = "user" | "assistant";
const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures.push(name);
};

async function coachSection() {
  const { coachTurn } = await import("../src/lib/coach");
  const { BUILT_IN_SCENARIOS, talkTrackSteps } = await import("../src/lib/scenarios");
  const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
  const steps = talkTrackSteps(scenario.callScript);

  const call: [Role, string][] = [
    ["assistant", scenario.aiPersona.openingLine],
    ["user", "Thanks for calling Rapid Flow Plumbing, this is Sam. I'm sorry to hear that, let's get it sorted."],
    ["assistant", "Thanks. It's making a real mess out there."],
    ["user", "What's going on exactly, and how urgent is it? Is water still coming out right now?"],
    ["assistant", "It started this morning. There's a puddle by the base of the tank."],
    ["user", "Got it. How old is the unit, and where exactly is the leak coming from? Have you shut the water off?"],
    ["assistant", "I think it's about eleven years old. I haven't touched the water valve, should I?"],
    ["user", "Yes, turn the cold supply valve on top of the heater clockwise. Can I get your name, the service address and the best callback number?"],
    ["assistant", "Okay. My name is Dana Whitfield, 42 Maple Court. Number is 555-0142."],
    ["user", "Thanks Dana. I have a technician available this afternoon between 2 and 4. Does that window work?"],
    ["assistant", "What does a visit cost? Nobody mentioned a fee."],
    ["user", "Fair question. The diagnostic visit is $89, and it's credited toward the repair if you go ahead."],
    ["assistant", "Alright, that works. Can you confirm someone will really show up this afternoon?"],
    ["user", "Yes. To confirm, Dana Whitfield at 42 Maple Court, 555-0142, between 2 and 4 today. You'll get a text with the technician's name when they're on the way."],
    ["assistant", "Sounds good, thanks."],
  ];

  console.log(`\n=== Live coach (heuristic): ${scenario.title} ===`);
  console.log(`Talk track:\n${steps.map((s, i) => `  [${i}] ${s}`).join("\n")}\n`);

  const transcript: { role: Role; text: string }[] = [];
  const recent: string[] = [];
  const overalls: number[] = [];
  const cues: { line: number; key?: string }[] = [];
  let lastSteps: boolean[] = [];
  for (const [role, text] of call) {
    transcript.push({ role, text });
    const r = await coachTurn(scenario, transcript, { allowCue: true, recentCueKeys: recent });
    const line = transcript.length;
    overalls.push(r.estimate.overall);
    lastSteps = r.steps;
    const crit = r.estimate.criteria.map((c) => `${c.id}=${c.score}${c.confirmed ? `@${c.evidenceLine}` : "~"}`).join(" ");
    console.log(`[${line}] ${role === "user" ? "REP   " : "CALLER"}: ${text}`);
    console.log(`     estimate ${String(r.estimate.overall).padStart(3)} | ${crit}`);
    console.log(`     steps [${r.steps.map((s) => (s ? "x" : ".")).join("")}] | talk ${r.talkRatio.toFixed(2)} | ${r.source} ${r.latencyMs}ms`);
    if (r.cue) {
      console.log(`     CUE ${r.cueKey} (turn ${r.cue.triggerTurn}${r.cue.criterionId ? `, ${r.cue.criterionId}` : ""}): ${r.cue.title} | ${r.cue.message}${r.cue.suggestedLine ? ` | say: "${r.cue.suggestedLine}"` : ""}`);
      recent.push(r.cueKey!);
      cues.push({ line, key: r.cueKey });
    }
  }

  console.log("");
  const feeLine = call.findIndex(([, t]) => t.startsWith("What does a visit cost")) + 1;
  check("price objection cue fires right after the fee question", cues.some((c) => c.line === feeLine && c.key === "objection:price"));
  check("estimate rises across the call", overalls[overalls.length - 1] > overalls[1] && overalls[5] > overalls[1]);
  check("estimate never drops by more than 5 points between turns", overalls.every((o, i) => i === 0 || o >= overalls[i - 1] - 5));
  check("every talk-track step is ticked by the end", lastSteps.length === steps.length && lastSteps.every(Boolean));
  check("no cue key repeats", new Set(cues.map((c) => c.key)).size === cues.length);

  // Targeted cue checks.
  const run = (turns: [Role, string][], allowCue = true, recentCueKeys: string[] = []) =>
    coachTurn(scenario, turns.map(([role, text]) => ({ role, text })), { allowCue, recentCueKeys });
  const stacked = await run([
    ["assistant", scenario.aiPersona.openingLine],
    ["user", "Okay. When did it start? How old is the heater? Is it gas or electric? Have you turned the water off?"],
  ]);
  check(`stacked questions -> guardrail cue (got ${stacked.cueKey ?? "none"})`, stacked.cueKey === "guardrail:length");
  const monologue = await run([
    ["assistant", scenario.aiPersona.openingLine],
    ["user", "Sure. So we are a family-owned company and we have been doing this for more than twenty years across the whole county, and our technicians are all licensed and insured, and we carry most parts on the truck, so usually we can fix things in one visit, and we also do tank and tankless installs, financing, maintenance plans and a lot more besides that."],
    ["assistant", "Okay."],
    ["user", "Yeah, and we also do drain cleaning and water softeners."],
  ]);
  check(`rep monologue -> whisper cue (got ${monologue.cueKey ?? "none"}, talk ${monologue.talkRatio})`, monologue.cueKey === "whisper:ratio");
  const guided = await run(call.slice(0, 11), false);
  check("allowCue=false never returns a cue", guided.cue === null && guided.cueKey === undefined);
  const repeat = await run(call.slice(0, 11), true, ["objection:price"]);
  check(`recent objection key is skipped (got ${repeat.cueKey ?? "none"})`, repeat.cueKey !== "objection:price");
  const empty = await run([]);
  check("empty transcript is safe", empty.estimate.overall === 0 && empty.cue === null && empty.talkRatio === 0);
}

async function wizardSection() {
  const { generatePersona } = await import("../src/lib/personaWizard");
  const { ScenarioSchema, talkTrackSteps } = await import("../src/lib/scenarios");
  const { scriptedReply } = await import("../src/lib/scriptedCaller");
  const input = {
    role: "sdr",
    industry: "Freight brokerage",
    callType: "cold" as const,
    difficulty: "medium" as const,
    product: "Our load-matching and carrier-vetting platform for mid-size brokerages. It cuts empty miles and flags risky carriers before a load is booked.",
    contexts: [
      {
        kind: "icp" as const,
        text: "VP of Operations at freight brokerages with 50-300 employees. They run their own carrier network, fight thin margins and lose hours every week to manual load matching and carrier compliance checks. Usually on a legacy TMS and wary of new software.",
      },
      {
        kind: "crm" as const,
        text: "Front desk said the VP prefers calls before 9am. The company added 40 trucks to its network in Q2 and posted about double-brokering fraud on LinkedIn last month.",
      },
    ],
  };

  console.log("\n=== Persona wizard (template): SDR cold call to a freight-broker VP ===");
  const out = await generatePersona(input);
  const s = out.scenario;
  console.log(`method: ${out.method}`);
  console.log(`title: ${s.title}`);
  console.log(`id: ${s.id} | industry: ${s.industry} | role: ${s.role} | callType: ${s.callType} | difficulty: ${s.difficulty} | ${s.durationMin} min | status: ${s.status}`);
  console.log(`persona: ${s.aiPersona.name}, ${s.aiPersona.role}`);
  console.log(`opening: "${s.aiPersona.openingLine}"`);
  console.log(`behavior: ${s.aiPersona.behavior}`);
  console.log(`goal: ${s.traineeGoal}`);
  console.log(`talk track:\n${s.callScript.split("\n").map((l) => `  ${l}`).join("\n")}`);
  console.log(`rubric:\n${s.rubric.map((c) => `  ${String(c.weight).padStart(3)}  ${c.id}: ${c.name} - ${c.description}`).join("\n")}`);
  console.log(`objections:\n${s.objections.map((o) => `  [${o.type}] "${o.line}" -> "${o.prepAnswer}"`).join("\n")}`);
  console.log(`sample replies:\n${s.sampleReplies.map((r) => `  - ${r}`).join("\n")}`);
  console.log(`sources:\n${Object.entries(out.sources).map(([k, v]) => `  ${k}: [${v.kind}] "${v.snippet}"`).join("\n")}`);

  console.log("");
  check("template output passes ScenarioSchema", ScenarioSchema.safeParse(s).success);
  check("method is template without a key", out.method === "template");
  check("rubric weights are integers summing to 100", s.rubric.every((c) => Number.isInteger(c.weight)) && s.rubric.reduce((a, c) => a + c.weight, 0) === 100);
  check("talk track has 5-7 steps", talkTrackSteps(s.callScript).length >= 5 && talkTrackSteps(s.callScript).length <= 7);
  check("persona title comes from the ICP context", /VP of Operations/.test(s.aiPersona.role) && out.sources["aiPersona.role"]?.kind === "icp");
  const contextText = input.contexts.map((c) => c.text).join("\n");
  const chips = [input.role, input.industry, "Cold call", input.difficulty, input.product].join("\n");
  check(
    "every source snippet is verbatim from its context or the chips (<= 140 chars)",
    Object.values(out.sources).every((v) => v.snippet.length <= 140 && (v.kind === "chips" ? chips : contextText).includes(v.snippet)),
  );
  check("id has the custom- prefix and builtIn is false", /^custom-[a-z0-9]+-[a-z0-9]{1,4}$/.test(s.id) && s.builtIn === false);
  const offline = scriptedReply(s, [{ role: "assistant", text: s.aiPersona.openingLine }, { role: "user", text: "What's the best number to reach you?" }]);
  check(`offline scripted caller answers a phone question ("${offline}")`, /555-0137/.test(offline));

  const regulated = await generatePersona({ role: "insurance", industry: "Home insurance", callType: "inbound", difficulty: "easy", product: "Home and contents insurance", contexts: [] });
  check("regulated field gets a compliance criterion", regulated.scenario.rubric.some((c) => c.id === "compliance") && regulated.scenario.rubric.reduce((a, c) => a + c.weight, 0) === 100);
  for (const callType of ["inbound", "cold", "discovery", "follow_up", "renewal", "negotiation", "collections", "service"] as const) {
    for (const role of ["ae", "home-services", "collections"]) {
      const r = await generatePersona({ role, industry: "", callType, difficulty: "hard", product: "", contexts: [] });
      if (!ScenarioSchema.safeParse(r.scenario).success) check(`template ${role}/${callType} passes ScenarioSchema`, false);
    }
  }
  check("every call type x family template passes ScenarioSchema", !failures.some((f) => f.startsWith("template ")));
}

async function safeFetchSection() {
  const { isBlockedIp, htmlToText, fetchPublicPage } = await import("../src/lib/safeFetch");
  console.log("\n=== safeFetch offline checks ===");
  const blocked = ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fd00:ec2::254", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"];
  const allowed = ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  check("blocks private, loopback, link-local, CGNAT, multicast, reserved and metadata IPs", blocked.every(isBlockedIp));
  check("allows public IPs", allowed.every((ip) => !isBlockedIp(ip)));
  const page = htmlToText(`<html><head><title>Acme &amp; Co &ndash; Freight</title><style>p{}</style><script>var x="<p>no</p>";</script></head><body><nav>Home</nav><h1>Load&nbsp;matching</h1><p>Cut empty miles &#8212; fast.</p><svg><text>icon</text></svg><noscript>enable js</noscript><!-- hidden --></body></html>`);
  check(`html to text keeps the title and visible text only (${JSON.stringify(page)})`, page.title === "Acme & Co – Freight" && page.text === "Home\nLoad matching\nCut empty miles — fast.");
  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://example.com:8080/", "ftp://example.com/", "http://user:pw@example.com/", "http://printer.local/", "http://metadata.google.internal/", "http://0x7f000001/", "http://intranet/"]) {
    const err = await fetchPublicPage(url).then(() => "fetched", (e: Error) => e.message);
    check(`rejects ${url} (${err})`, err !== "fetched" && !/couldn't reach|too long/.test(err));
  }
}

async function main() {
  await coachSection();
  await wizardSection();
  await safeFetchSection();
  console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
