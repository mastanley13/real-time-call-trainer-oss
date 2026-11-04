import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { teamIsLocal } from "../_lib/server";
import { accessDenied, loadMembersActor, loadMembersPayload, samplePayload, serverError } from "../_lib/members";

/**
 * GET: the organization's members, open invites (pending and expired) and seat use, for Settings > Members.
 * Owners and managers can read it; only an owner of a Team-plan organization gets `access: "manage"`.
 * Demo mode and database-less installs answer with the sample page (`?demo=full` for every seat taken).
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return NextResponse.json(samplePayload(req));

  try {
    const ctx = await loadMembersActor(auth.id);
    if (!ctx) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!ctx.org) return accessDenied("no_organization");
    if (ctx.access === "forbidden") return accessDenied("forbidden");
    return NextResponse.json(await loadMembersPayload(ctx.actor.id, ctx.org, ctx.access, new Date()));
  } catch (error) {
    console.error("[/api/team/members] GET error:", error instanceof Error ? error.name : "unknown");
    return serverError("load your team");
  }
}
