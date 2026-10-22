import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { chat } from "@/lib/llm";
import { llmKey } from "@/lib/serverConfig";

const Body = z.object({
  scenario: ScenarioSchema,
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(200),
});

/**
 * Text-only simulated caller. Uses the configured LLM when available;
 * otherwise walks through the scenario's scripted sampleReplies.
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
          // The persona is the "assistant"; the trainee is the "user".
          ...history.map((h) => ({ role: h.role, content: h.text })),
        ],
        { maxTokens: 200, temperature: 0.8 },
      );
      return NextResponse.json({ reply: reply.trim(), source: "llm" });
    } catch (e) {
      console.error("[simulate] LLM failed:", (e as Error).message);
    }
  }

  const callerTurns = history.filter((h) => h.role === "assistant").length;
  const scripted = scenario.sampleReplies;
  if (scripted.length === 0) {
    return NextResponse.json({ reply: "Mm-hm. Go on.", source: "scripted" });
  }
  // The opening line counts as the first caller turn; replies start at index 0.
  const reply = scripted[Math.max(0, callerTurns - 1) % scripted.length];
  return NextResponse.json({ reply, source: "scripted" });
}
