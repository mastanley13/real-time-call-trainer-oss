import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { WizardInputSchema } from "@/lib/wizard-types";
import { generatePersona } from "@/lib/personaWizard";

/**
 * AI persona wizard: WizardInput (chips, product line, up to 5 contexts) ->
 * WizardOutput (a complete Scenario plus per-field sources). Uses the LLM when
 * configured and a template otherwise, so it always returns a usable scenario.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "wizard");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "wizard");
  if (userLimited) return userLimited;

  let input: z.infer<typeof WizardInputSchema>;
  try {
    input = WizardInputSchema.parse(await readJsonLimited(req));
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid request body", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await generatePersona(input));
  } catch (error) {
    console.error("[/api/persona/generate] error:", error);
    return NextResponse.json({ error: "Failed to generate persona" }, { status: 500 });
  }
}
