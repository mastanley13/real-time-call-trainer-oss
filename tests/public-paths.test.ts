import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath, VERTICAL_SLUGS } from "@/lib/publicPaths";
import { proxy } from "@/proxy";

describe("isPublicPath", () => {
  it.each([
    "/pricing", "/register", "/login", "/robots.txt", "/sitemap.xml",
    "/for/insurance", "/for/solar", "/for/staffing", "/for/home-services", "/for/saas-sdr", "/for/coaches",
    "/api/auth/login", "/api/auth/mfa/challenge", "/auth/complete", "/opengraph-image", "/opengraph-image-1a2b3c", "/twitter-image", "/pricing/",
    "/twitter-image-9f8e7d", "/opengraph-image?abc123", "/opengraph-image-1a2b3c?v=2#top", "/twitter-image?x=1",
    "/for/insurance/opengraph-image", "/for/solar/twitter-image", "/for/coaches/opengraph-image-1a2b3c",
    "/for/saas-sdr/twitter-image?abc123", "/for/home-services/opengraph-image-1a2b3c?v=2#x", "/sitemap.xml?x=1", "/robots.txt#a",
    "/library", "/library/", "/library?x=1",
    "/alternatives", "/alternatives/", "/alternatives?utm_source=x",
    "/vs/second-nature", "/vs/hyperbound", "/vs/yoodli", "/vs/yoodli/", "/vs/hyperbound?src=x#faq",
    "/alternatives/hyperbound", "/alternatives/yoodli", "/alternatives/hyperbound/", "/alternatives/yoodli?utm_source=x",
    "/ai-sales-roleplay", "/ai-sales-roleplay/", "/ai-sales-roleplay?src=x",
    "/use-cases/alarm-monitoring", "/use-cases/911-dispatch", "/use-cases/alarm-monitoring/", "/use-cases/911-dispatch#faq",
  ])("allows %s",(p) => expect(isPublicPath(p)).toBe(true));

  it.each([
    "/vs", "/vs/", "/vs/unknown", "/vs/second-nature/x", "/vsx/yoodli", "/alternatives/x", "/alternativesx", "/dashboard?next=/vs/yoodli",
    "/ai-sales-roleplay/x", "/use-cases", "/use-cases/", "/use-cases/unknown", "/use-cases/alarm-monitoring/x",
  ])("keeps the unlisted comparison path %s gated", (p) => expect(isPublicPath(p)).toBe(false));

  it.each([
    "/dashboard", "/trainer", "/team", "/settings/security", "/library/new", "/libraryx", "/library/x", "/api/config", "/api/transcripts", "/api/scenarios",
    "/api/auth", "/for", "/for/unknown", "/pricing-x", "/privacy/evil", "/register/x", "/auth", "/auth/complete/x", "/auth/other",
    "/opengraph-imagex/evil", "/opengraph-image-evil/x", "/for/unknown/opengraph-image", "/for/solar/opengraph-image/x",
    "/dashboard?next=/opengraph-image", "/api/config#/robots.txt", "/dashboard/opengraph-image",
  ])("keeps %s gated", (p) => expect(isPublicPath(p)).toBe(false));

  it("covers every vertical slug", () => expect(VERTICAL_SLUGS).toHaveLength(6));

  it.each([
    "/forgot-password", "/reset-password", "/forgot-password/", "/reset-password?token=v1.abc.123.fp.sig",
    "/api/auth/password-reset/request", "/api/auth/password-reset/confirm", "/api/auth/password-reset/check",
  ])("allows the password reset path %s", (p) => expect(isPublicPath(p)).toBe(true));

  it.each(["/forgot-password/x", "/reset-password/x", "/forgot-passwordx", "/reset", "/dashboard?next=/reset-password"])(
    "keeps %s gated",
    (p) => expect(isPublicPath(p)).toBe(false),
  );

  it.each([
    "/try/dealership", "/try/real-estate", "/try/staffing", "/try/insurance",
    "/try/dealership/", "/try/real-estate?utm_source=email", "/try/staffing/?utm_campaign=q4#top", "/try/insurance#x",
  ])("allows the try page %s", (p) => expect(isPublicPath(p)).toBe(true));

  it("treats /try/ as a prefix, so an unknown role reaches the App Router 404 instead of the access gate", () => {
    expect(isPublicPath("/try/unknown")).toBe(true);
    expect(isPublicPath("/try/unknown?utm_source=x")).toBe(true);
  });

  it.each(["/try", "/try/", "/tryx", "/trying", "/trainer?next=/try/dealership", "/dashboard#/try/dealership", "/x/try/dealership"])(
    "keeps %s gated",
    (p) => expect(isPublicPath(p)).toBe(false),
  );
});

describe("proxy with TRAINER_ACCESS_CODE set", () => {
  const prev = process.env.TRAINER_ACCESS_CODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.TRAINER_ACCESS_CODE;
    else process.env.TRAINER_ACCESS_CODE = prev;
  });
  const run = (path: string) => {
    process.env.TRAINER_ACCESS_CODE = "letmein";
    return proxy(new NextRequest(`http://localhost:3000${path}`));
  };

  it("lets public pages through without a cookie", async () => {
    for (const p of ["/", "/pricing", "/privacy", "/terms", "/for/insurance", "/register", "/login", "/api/auth/login", "/opengraph-image", "/twitter-image", "/for/solar/opengraph-image", "/for/solar/twitter-image-1a2b3c", "/sitemap.xml", "/robots.txt"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
  });

  it("lets the /try pages through without a cookie, unknown roles too (they 404 in the App Router)", async () => {
    for (const p of ["/try/dealership", "/try/real-estate", "/try/staffing", "/try/insurance", "/try/dealership?utm_source=email&utm_campaign=q4", "/try/unknown"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
    expect((await run("/try")).status).toBe(307);
  });

  it("keeps Google sign-in reachable for existing users without an access cookie, like password login", async () => {
    // Button discovery, the redirect out and back, the session hand-off, and the landing page that stores it.
    for (const p of ["/api/auth/google/status", "/api/auth/google/start", "/api/auth/google/callback?code=x&state=y", "/api/auth/session", "/auth/complete?next=%2Flibrary"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
    // The gated capability endpoint is not what the button depends on.
    expect((await run("/api/config")).status).toBe(401);
  });

  it("serves the /library catalog without a cookie but keeps the wizard and private data gated", async () => {
    const res = await run("/library");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
    const wizard = await run("/library/new");
    expect(wizard.status).toBe(307);
    expect(new URL(wizard.headers.get("location")!).pathname).toBe("/access");
    expect((await run("/api/scenarios")).status).toBe(401);
  });

  it("serves /alternatives and the three /vs pages without a cookie, and gates unknown /vs paths", async () => {
    for (const p of ["/alternatives", "/vs/second-nature", "/vs/hyperbound", "/vs/yoodli"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
    expect((await run("/vs/unknown")).status).toBe(307);
  });

  it("serves the new SEO landings without a cookie, and gates unknown alternative and use-case paths", async () => {
    for (const p of ["/ai-sales-roleplay", "/alternatives/hyperbound", "/alternatives/yoodli", "/use-cases/alarm-monitoring", "/use-cases/911-dispatch"]) {
      const res = await run(p);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.status, p).toBe(200);
    }
    expect((await run("/alternatives/unknown")).status).toBe(307);
    expect((await run("/use-cases/unknown")).status).toBe(307);
  });

  it("every sitemap URL is reachable through the gate", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname;
      const res = await run(path);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("still redirects /dashboard to /access", async () => {
    const res = await run("/dashboard");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/access");
  });

  it("keeps the checkout query through the access gate, so plan and interval survive", async () => {
    const res = await run("/checkout/start?plan=team&interval=year");
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/access");
    expect(to.searchParams.get("next")).toBe("/checkout/start?plan=team&interval=year");
  });

  it("a path with no query still sends just the path", async () => {
    const res = await run("/trainer");
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/trainer");
  });

  it("still returns 401 for gated API routes", async () => {
    const res = await run("/api/config");
    expect(res.status).toBe(401);
  });
});
