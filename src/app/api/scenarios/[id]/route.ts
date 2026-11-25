import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { ipLimitResponse, userLimitResponse } from "@/lib/rateLimit";
import { canReadScenario, changeCustomScenario, notFound, parseScenarioBody, ScenarioId, scenarioActor, scenarioDatabaseAvailable, scenarioDatabaseUnavailable, scenarioRecord, ScenarioUpdateBody, unknownUser } from "@/lib/customScenarios";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!scenarioDatabaseAvailable()) return scenarioDatabaseUnavailable();
  const { id } = await params;
  if (!ScenarioId.safeParse(id).success) return notFound();
  const actor = await scenarioActor(auth.id);
  if (!actor) return unknownUser();
  const row = await prisma.customScenario.findUnique({ where: { id } });
  if (!row || !canReadScenario(actor, row)) return notFound();
  return NextResponse.json({ item: scenarioRecord(actor, row) });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "scenarios");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "scenarios");
  if (userLimited) return userLimited;
  const body = await parseScenarioBody(req, ScenarioUpdateBody);
  if (body instanceof NextResponse) return body;
  if (!scenarioDatabaseAvailable()) return scenarioDatabaseUnavailable();
  return changeCustomScenario(auth.id, (await params).id, body);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "scenarios");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "scenarios");
  if (userLimited) return userLimited;
  if (!scenarioDatabaseAvailable()) return scenarioDatabaseUnavailable();
  return changeCustomScenario(auth.id, (await params).id);
}
