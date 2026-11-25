import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { ipLimitResponse, userLimitResponse } from "@/lib/rateLimit";
import { ScenarioSaveBody, parseScenarioBody, saveCustomScenario, scenarioActor, scenarioDatabaseAvailable, scenarioDatabaseUnavailable, scenarioRecord, unknownUser } from "@/lib/customScenarios";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!scenarioDatabaseAvailable()) return NextResponse.json({ scenarios: [], persistence: "local" });

  const actor = await scenarioActor(auth.id);
  if (!actor) return unknownUser();
  const rows = await prisma.customScenario.findMany({
    where: { OR: [
      { userId: actor.id },
      ...(actor.organizationId ? [{ organizationId: actor.organizationId, sharedWithOrg: true }] : []),
    ] },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ scenarios: rows.map((row) => scenarioRecord(actor, row)), persistence: "database" });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "scenarios");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "scenarios");
  if (userLimited) return userLimited;
  const body = await parseScenarioBody(req, ScenarioSaveBody);
  if (body instanceof NextResponse) return body;
  if (!scenarioDatabaseAvailable()) return scenarioDatabaseUnavailable();
  return saveCustomScenario(auth.id, body);
}
