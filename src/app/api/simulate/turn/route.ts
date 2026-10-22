import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited, MAX_TURNS, MAX_TRANSCRIPT_CHARS } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { chatFull } from "@/lib/llm";
import { scriptedReply } from "@/lib/scriptedCaller";
import { llmKey } from "@/lib/serverConfig";

const Body = z.object({
  scenario: ScenarioSchema,
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(MAX_TURNS),
}).refine((b) => b.history.reduce((n, t) => n + t.text.length, 0) <= MAX_TRANSCRIPT_CHARS, { message: "history too long" });

const END_TOKEN = "[END_CALL]";
const GOODBYE_RE = /\b(good-?bye|bye(-bye)?|talk to you (later|soon)|have a (good|great|nice|wonderful) (day|one|evening|afternoon|night)|take care)\b[^?]*$/i;

/** Trim a length-truncated reply back to its last complete sentence (never mid-word). */
function trimToSentence(t: string): string {
  const m = t.match(/^[\s\S]*[.!?]["')\]]?(?=\s|$)/);
  if (m && m[0].trim().length >= 10) return m[0].trim();
  const sp = t.lastIndexOf(" ");
  return `${(sp > 0 ? t.slice(0, sp) : t).replace(/[,;:\s-]+$/, "")}…`;
}

/** Merge consecutive same-role turns (queued trainee messages) into one. */
function mergeTurns(h: { role: "user" | "assistant"; text: string }[]) {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of h) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n${t.text}`;
    else out.push({ role: t.role, content: t.text });
  }
  return out;
}

/**
 * Text-only simulated caller. Uses the configured LLM when available;
 * otherwise answers from the scenario's scripted replies by matching the trainee's intent.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "caller");
  if (ipLimited) return ipLimited;
  const limit = rateLimit({ key: `simulate:${auth.id}`, limit: 40, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "That conversation is too long or malformed to continue. End the call to get graded." }, { status: 400 });
  }
  const { scenario, history } = body;

  if (llmKey()) {
    try {
      const { text, truncated } = await chatFull(
        [
          { role: "system", content: `${buildAgentPrompt(scenario)}\n\nThis call is happening over text chat; keep replies short and conversational (1-3 sentences). When the conversation has reached its natural end and you are saying goodbye, finish your message with ${END_TOKEN}.` },
          // The persona is the "assistant"; the trainee is the "user". Some
          // providers (Anthropic) require the first turn to be from the user.
          ...(history[0]?.role === "assistant" ? [{ role: "user" as const, content: "(The call connects.)" }] : []),
          ...mergeTurns(history),
        ],
        { maxTokens: 500, temperature: 0.8 },
      );
      const hadEnd = text.includes(END_TOKEN);
      let reply = text.replace(END_TOKEN, "").trim();
      if (truncated && !hadEnd) reply = trimToSentence(reply);
      return NextResponse.json({ reply, ended: hadEnd || GOODBYE_RE.test(reply), source: "llm" });
    } catch (e) {
      console.error("[simulate] LLM failed:", (e as Error).message);
    }
  }

  const reply = scriptedReply(scenario, history);
  return NextResponse.json({ reply, ended: GOODBYE_RE.test(reply), source: "scripted" });
}
