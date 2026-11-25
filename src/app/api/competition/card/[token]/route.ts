import { NextRequest, NextResponse } from "next/server";
import { getCompetitionShareCard } from "@/lib/competitionServer";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = /^[A-Za-z0-9_-]{4,40}$/.test(token) ? await getCompetitionShareCard(token) : null;
  return card ? NextResponse.json(card, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "not_found" }, { status: 404 });
}
