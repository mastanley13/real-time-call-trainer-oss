import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { chat } from "@/lib/llm";
import { scriptedReply } from "@/lib/scriptedCaller";
import { llmKey } from "@/lib/serverConfig";

const Body = z.object({
  scenario: ScenarioSchema,
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(200),
});

/**
 * Text-only simulated caller. Uses the configured LLM when available;
 * otherwise answers from the scenario's scripted replies by matching the trainee's intent.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limit = rateLimit({ key: `simulate:${auth.id}`, limit: 40, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { scenario, history } = body;

  if (llmKey()) {
    try {
      const reply = await chat(
        [
          { role: "system", content: `${buildAgentPrompt(scenario)}\n\nThis call is happening over text chat; keep replies short and conversational.` },
          // The persona is the "assistant"; the trainee is the "user". Some
          // providers (Anthropic) require the first turn to be from the user.
          ...(history[0]?.role === "assistant" ? [{ role: "user" as const, content: "(The call connects.)" }] : []),
          ...history.map((h) => ({ role: h.role, content: h.text })),
        ],
        { maxTokens: 200, temperature: 0.8 },
      );
      return NextResponse.json({ reply: reply.trim(), source: "llm" });
    } catch (e) {
      console.error("[simulate] LLM failed:", (e as Error).message);
    }
  }

  return NextResponse.json({ reply: scriptedReply(scenario, history), source: "scripted" });
}
