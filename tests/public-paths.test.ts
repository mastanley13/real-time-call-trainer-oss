import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath, VERTICAL_SLUGS } from "@/lib/publicPaths";
import { middleware } from "@/middleware";

describe("isPublicPath", () => {
  it.each([
    "/pricing", "/register", "/login", "/robots.txt", "/sitemap.xml",
    "/for/insurance", "/for/solar", "/for/staffing", "/for/home-services", "/for/saas-sdr", "/for/coaches",
    "/api/auth/login", "/api/auth/mfa/challenge", "/opengraph-image", "/opengraph-image-1a2b3c", "/twitter-image", "/pricing/",
  ])("allows %s", (p) => expect(isPublicPath(p)).toBe(true));

  it.each([
    "/dashboard", "/trainer", "/team", "/settings/security", "/library", "/api/config", "/api/transcripts",
    "/api/auth", "/for", "/for/unknown", "/pricing-x", "/privacy/evil", "/register/x",
  ])("keeps %s gated", (p) => expect(isPublicPath(p)).toBe(false));

  it("covers every vertical slug", () => expect(VERTICAL_SLUGS).toHaveLength(6));
});

describe("middleware with TRAINER_ACCESS_CODE set", () => {
  const prev = process.env.TRAINER_ACCESS_CODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TRAINER_ACCESS_CODE;
    else process.env.TRAINER_ACCESS_CODE = prev;
  });
  const run = (path: string) => {
    process.env.TRAINER_ACCESS_CODE = "letmein";
    return middleware(new NextRequest(`http://localhost:3000${path}`));
  };

  it("lets public pages through without a cookie", async () => {
    for (const p of ["/", "/pricing", "/privacy", "/terms", "/for/insurance", "/register", "/login", "/api/auth/login", "/opengraph-image"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
  });

  it("still redirects /dashboard to /access", async () => {
    const res = await run("/dashboard");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/access");
  });

  it("still returns 401 for gated API routes", async () => {
    const res = await run("/api/config");
    expect(res.status).toBe(401);
  });
});
