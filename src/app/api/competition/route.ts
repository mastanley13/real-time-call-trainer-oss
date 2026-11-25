import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, isDemoUser } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { isCompetitionPeriod, isCompetitionTrackSlug } from "@/lib/competition";
import { getCompetitionStatus, updateCompetitionProfile } from "@/lib/competitionServer";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  const userId = auth instanceof NextResponse || isDemoUser(auth) ? null : auth.id;
  const track = req.nextUrl.searchParams.get("track");
  const period = req.nextUrl.searchParams.get("period");
  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : undefined;
  return NextResponse.json(
    await getCompetitionStatus({
      userId,
      track: isCompetitionTrackSlug(track) ? track : null,
      period: isCompetitionPeriod(period) ? period : "month",
      limit,
    }),
    { headers: { "Cache-Control": "no-store" } },
  );
}
const Body = z.object({ displayName: z.string().min(1).max(40), teamLabel: z.string().max(48).nullable().optional() });
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (isDemoUser(auth)) return NextResponse.json({ error: "competition_requires_account", message: "Sign in to edit your competition profile." }, { status: 400 });
  const limited = ipLimitResponse(req, "competition") ?? userLimitResponse(auth.id, "competition");
  if (limited) return limited;
  let body: z.infer<typeof Body>;
  try { body = Body.parse(await readJsonLimited(req)); }
  catch { return NextResponse.json({ error: "invalid_request", message: "Enter a display name and an optional team label." }, { status: 400 }); }
  const profile = await updateCompetitionProfile(auth.id, body);
  if (!profile) return NextResponse.json({ error: "invalid_profile", message: "Enter a display name without an email address." }, { status: 400 });
  return NextResponse.json(profile, { headers: { "Cache-Control": "no-store" } });
}
