import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessCode, accessToken, codeMatches } from "@/lib/access";
import { ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  const limited = ipLimitResponse(req, "access");
  if (limited) return limited;

  const code = accessCode();
  if (!code) return NextResponse.json({ ok: true });

  let input = "";
  try {
    const body = (await readJsonLimited(req)) as { code?: unknown };
    if (typeof body.code === "string") input = body.code.slice(0, 200);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!(await codeMatches(input.trim(), code))) {
    return NextResponse.json({ error: "That code isn't right." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, await accessToken(code), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE,
  });
  return res;
}
