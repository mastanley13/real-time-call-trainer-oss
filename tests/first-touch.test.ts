import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// The database is the only fake: middleware, the register route and the GHL signup queue run for real.
const h = vi.hoisted(() => ({ users: [] as any[], outbox: [] as any[], seq: 0 }));
vi.mock("@/lib/db", () => {
  const models = {
    user: {
      findUnique: async ({ where }: any) => {
        const u = h.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
        return u ? { ...u, organization: { planTier: "free", code: "123456" } } : null;
      },
      create: async ({ data }: any) => {
        const u = { id: `u${h.users.length + 1}`, createdAt: new Date("2026-11-02T10:00:00.000Z"), isPlatformAdmin: false, ...data };
        h.users.push(u);
        return { ...u, organization: { id: "o1", name: data.organizationId, code: "123456" } };
      },
    },
    organization: { findUnique: async () => null, create: async ({ data }: any) => ({ id: "o1", ...data }) },
    auditEvent: { create: async () => ({}) },
    ghlOutbox: {
      findMany: async ({ where }: any) => h.outbox.filter((r) => r.userId === where.userId),
      createMany: async ({ data }: any) => {
        for (const d of data) h.outbox.push({ ...d, seq: ++h.seq });
        return { count: data.length };
      },
    },
  };
  const prisma = { ...models, $transaction: async (fn: any) => fn({ ...models, $executeRaw: async () => 1 }) };
  return { prisma };
});

import { middleware } from "@/middleware";
import { POST as register } from "@/app/api/auth/register/route";
import { enqueueSignup } from "@/lib/ghl/events";
import { actionsFor, type GhlPayload } from "@/lib/ghl/types";
import { ACCESS_COOKIE, accessToken, safeNextPath } from "@/lib/access";
import { registerHref, withPageUtm } from "@/lib/pricing";
import { LANDINGS } from "@/lib/landing";
import { FT_COOKIE, FT_MAX_AGE, inboundSource, parseTouchCookie, referrerHost, sanitizeTouch, sanitizeTouchValue, touchForRegister } from "@/lib/firstTouch";

const SITE = "https://calltrainer.tech";
const TAGGED = "utm_source=linkedin&utm_medium=dm&utm_campaign=launch-2026&utm_content=d1-dm01";
const ENV_KEYS = ["TRAINER_ACCESS_CODE", "JWT_SECRET", "DATABASE_URL", "DEMO_MODE", "GHL_SYNC_ENABLED", "GHL_INBOUND_WEBHOOK_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let ip = 0;
beforeEach(() => {
  h.users.length = 0;
  h.outbox.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.JWT_SECRET = "test-secret-not-real-0123456789abcdef";
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const visit = (url: string, headers: Record<string, string> = {}) => middleware(new NextRequest(url, { headers }));
/** The raw Set-Cookie header for ct_ft, or undefined when none was set. */
const ftSetCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(`${FT_COOKIE}=`));
/** "name=value" for a Cookie request header, as the browser would send it back. */
const cookiePair = (setCookie: string) => setCookie.split(";")[0];

async function signUp(body: Record<string, unknown>, cookie?: string) {
  const res = await register(
    new NextRequest(`${SITE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++ip}`, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ firstName: "Sam", lastName: "Lee", email: `sam${ip}@example.com`, password: "correct-horse-battery", newOrgName: "Harbor Point", ...body }),
    }),
  );
  return { res, user: h.users[h.users.length - 1] };
}

/** Queues the signup for the last user exactly as emitSignup would, and returns its GHL payload. */
async function ghlSignup(userId: string): Promise<GhlPayload> {
  process.env.GHL_SYNC_ENABLED = "true";
  process.env.GHL_INBOUND_WEBHOOK_URL = "https://hooks.example.com/in";
  await enqueueSignup(userId);
  return h.outbox.find((r) => r.userId === userId && r.event === "signup")!.payload;
}

describe("first touch, end to end", () => {
  it("tags on the landing page reach the register payload, the user record and the GHL signup", async () => {
    const landing = await visit(`${SITE}/?${TAGGED}`);
    const set = ftSetCookie(landing)!;
    expect(set).toBeDefined();

    // /register reads the cookie (the URL here carries no tags at all).
    const cookie = cookiePair(set);
    const sent = touchForRegister(cookie, "?plan=pro");
    expect(sent).toEqual({ utmSource: "linkedin", utmMedium: "dm", utmCampaign: "launch-2026", utmContent: "d1-dm01" });

    const { res, user } = await signUp(sent, cookie);
    expect(res.status).toBe(200);
    expect(user).toMatchObject({ utmSource: "linkedin", utmMedium: "dm", utmCampaign: "launch-2026", utmContent: "d1-dm01" });
    expect(user.utmTerm).toBeUndefined();
    expect(user.referrer).toBeUndefined();

    const payload = await ghlSignup(user.id);
    expect(payload).toMatchObject({ source: "linkedin/launch-2026", utmSource: "linkedin", utmMedium: "dm", utmCampaign: "launch-2026", utmContent: "d1-dm01", utmTerm: null, referrer: null });
    const actions = actionsFor(payload);
    expect(actions.fields).toMatchObject({ inbound_source: "linkedin/launch-2026", ct_utm_source: "linkedin", ct_utm_medium: "dm", ct_utm_campaign: "launch-2026", ct_utm_content: "d1-dm01" });
    expect(actions.fields).not.toHaveProperty("ct_referrer");
    expect(actions.addTags).toEqual(["ct-trial", "ct-outbound"]);
  });

  it("the cookie wins over tags on the /register URL, and the server prefers it over the body", async () => {
    const cookie = cookiePair(ftSetCookie(await visit(`${SITE}/?${TAGGED}`))!);
    expect(touchForRegister(cookie, "?utm_source=google&utm_campaign=other").utmSource).toBe("linkedin");
    const { user } = await signUp({ utmSource: "google", utmCampaign: "other" }, cookie);
    expect(user).toMatchObject({ utmSource: "linkedin", utmCampaign: "launch-2026" });
  });

  it("without a cookie, the tags on the /register URL are used", async () => {
    const sent = touchForRegister("", "?plan=team&utm_source=Newsletter&utm_medium=email");
    expect(sent).toEqual({ utmSource: "newsletter", utmMedium: "email" });
    const { user } = await signUp(sent);
    expect(user).toMatchObject({ utmSource: "newsletter", utmMedium: "email" });
    expect((await ghlSignup(user.id)).source).toBe("newsletter");
  });
});

describe("first touch with the access gate on", () => {
  beforeEach(() => {
    process.env.TRAINER_ACCESS_CODE = "let-me-in";
  });

  it("a tagged gated URL redirects to /access with the full URL in next, sets the cookie, and returns with tags", async () => {
    const res = await visit(`${SITE}/trainer?${TAGGED}`);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/access");
    const next = loc.searchParams.get("next")!;
    expect(next).toBe(`/trainer?${TAGGED}`);
    expect(parseTouchCookie(decodeURIComponent(cookiePair(ftSetCookie(res)!).slice(FT_COOKIE.length + 1)))).toMatchObject({ utmSource: "linkedin", utmCampaign: "launch-2026" });

    // After the code: /access follows next, and the gate lets the tagged URL through without touching ct_ft.
    const back = safeNextPath(next, SITE);
    expect(back).toBe(`/trainer?${TAGGED}`);
    const again = await visit(`${SITE}${back}`, { cookie: `${ACCESS_COOKIE}=${await accessToken("let-me-in")}; ${cookiePair(ftSetCookie(res)!)}` });
    expect(again.status).toBe(200);
    expect(again.headers.get("location")).toBeNull();
    expect(ftSetCookie(again)).toBeUndefined();
  });

  it("public pages stay open with the gate on and still record the first touch", async () => {
    const home = await visit(`${SITE}/?utm_source=x`);
    expect(home.headers.get("location")).toBeNull();
    expect(ftSetCookie(home)).toBeDefined();
    const vertical = await visit(`${SITE}/for/saas-sdr?utm_source=y`);
    expect(vertical.headers.get("location")).toBeNull();
    expect(ftSetCookie(vertical)).toBeDefined();
  });

  it("keeps the query string on any gated page", async () => {
    expect(new URL((await visit(`${SITE}/library?utm_source=x&tab=mine`)).headers.get("location")!).searchParams.get("next")).toBe("/library?utm_source=x&tab=mine");
    expect(new URL((await visit(`${SITE}/library`)).headers.get("location")!).searchParams.get("next")).toBe("/library");
  });

  it("register keeps its 403 without the access cookie, even with first-touch tags, and creates no user", async () => {
    const cookie = cookiePair(ftSetCookie(await visit(`${SITE}/?${TAGGED}`))!);
    const { res } = await signUp({ utmSource: "linkedin" }, cookie);
    expect(res.status).toBe(403);
    expect(h.users).toHaveLength(0);
    const ok = await signUp({}, `${cookie}; ${ACCESS_COOKIE}=${await accessToken("let-me-in")}`);
    expect(ok.res.status).toBe(200);
    expect(ok.user).toMatchObject({ utmSource: "linkedin", utmCampaign: "launch-2026" });
  });

  it("API routes still answer 401 and never set the cookie", async () => {
    const res = await visit(`${SITE}/api/scenarios?utm_source=x`);
    expect(res.status).toBe(401);
    expect(ftSetCookie(res)).toBeUndefined();
  });
});

describe("safeNextPath: no open redirect from /access", () => {
  it.each([
    ["https://evil.com/x", "/"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["/\t/evil.com", "/"],
    ["javascript:alert(1)", "/"],
    ["http://calltrainer.tech/x", "/"],
    ["", "/"],
    [null, "/"],
    ["/library?utm_source=a#top", "/library?utm_source=a#top"],
  ])("%j -> %s", (next, want) => {
    expect(safeNextPath(next, SITE)).toBe(want);
  });
});

describe("first touch wins", () => {
  it("a second visit with different UTMs does not overwrite the cookie", async () => {
    const first = cookiePair(ftSetCookie(await visit(`${SITE}/?${TAGGED}`))!);
    const second = await visit(`${SITE}/?utm_source=google&utm_medium=cpc&utm_campaign=retarget`, { cookie: first, referer: "https://www.google.com/" });
    expect(ftSetCookie(second)).toBeUndefined();
    expect(touchForRegister(first, "?utm_source=google").utmSource).toBe("linkedin");
  });

  it("a direct visit stores nothing, so a later tagged visit is still the first touch", async () => {
    expect(ftSetCookie(await visit(`${SITE}/library`))).toBeUndefined();
    expect(ftSetCookie(await visit(`${SITE}/library?utm_source=x`))).toBeDefined();
  });
});

describe("referrer and inbound_source", () => {
  it("no UTM plus a news.ycombinator.com referrer gives inbound_source=news.ycombinator.com", async () => {
    const res = await visit(`${SITE}/`, { referer: "https://news.ycombinator.com/item?id=123&p=2" });
    const cookie = cookiePair(ftSetCookie(res)!);
    const sent = touchForRegister(cookie, "");
    expect(sent).toEqual({ referrer: "news.ycombinator.com" });
    const { user } = await signUp(sent, cookie);
    expect(user.referrer).toBe("news.ycombinator.com");
    const payload = await ghlSignup(user.id);
    expect(payload.source).toBe("news.ycombinator.com");
    expect(actionsFor(payload).fields).toMatchObject({ inbound_source: "news.ycombinator.com", ct_referrer: "news.ycombinator.com" });
    expect(actionsFor(payload).addTags).toEqual(["ct-trial"]);
  });

  it("a direct signup gives inbound_source=direct and writes no first-touch fields", async () => {
    const { user } = await signUp(touchForRegister("", ""));
    const payload = await ghlSignup(user.id);
    expect(payload.source).toBe("direct");
    expect(Object.keys(actionsFor(payload).fields).filter((k) => k.startsWith("ct_"))).toEqual([]);
  });

  it("our own hosts, ports, paths and non-web schemes never become a referrer", () => {
    for (const own of ["https://calltrainer.tech/pricing", "https://www.calltrainer.tech/", "https://app.calltrainer.tech/x?y=1"]) expect(referrerHost(own)).toBeUndefined();
    expect(referrerHost("http://localhost:3000/x", "localhost")).toBeUndefined();
    expect(referrerHost("android-app://com.linkedin.android/")).toBeUndefined();
    expect(referrerHost("not a url")).toBeUndefined();
    expect(referrerHost("https://WWW.LinkedIn.com:443/feed/?trk=abc")).toBe("www.linkedin.com");
    expect(referrerHost("https://evilcalltrainer.tech/")).toBe("evilcalltrainer.tech");
    expect(sanitizeTouch({ referrer: "www.calltrainer.tech" })).toEqual({});
  });

  it("inbound_source falls back from source/campaign to source, referrer, then direct", () => {
    expect(inboundSource({ utmSource: "linkedin", utmCampaign: "launch-2026", referrer: "x.com" })).toBe("linkedin/launch-2026");
    expect(inboundSource({ utmSource: "linkedin", referrer: "x.com" })).toBe("linkedin");
    expect(inboundSource({ utmCampaign: "launch-2026", referrer: "x.com" })).toBe("x.com");
    expect(inboundSource({})).toBe("direct");
  });

  it("utm_medium=outbound also tags ct-outbound; other mediums do not", () => {
    const base = { event: "signup", occurredAt: "2026-11-02T10:00:00.000Z", user: { id: "u", email: "a@b.co", firstName: "A" }, plan: "free", segment: null, minuteCap: 20, voiceMinutesUsed: 0, source: "x", referredByPartner: null, stripeCustomerId: null } as const;
    expect(actionsFor({ ...base, utmMedium: "outbound" }).addTags).toContain("ct-outbound");
    expect(actionsFor({ ...base, utmMedium: "cpc" }).addTags).not.toContain("ct-outbound");
    expect(actionsFor(base).addTags).toEqual(["ct-trial"]);
  });
});

describe("sanitizing and the cookie itself", () => {
  it("lowercases, keeps [a-z0-9-_.], caps at 120 and drops values that leave nothing", () => {
    expect(sanitizeTouchValue("LinkedIn Ads!")).toBe("linkedinads");
    expect(sanitizeTouchValue("<script>alert(1)</script>")).toBe("scriptalert1script");
    expect(sanitizeTouchValue("launch_2026.v-2")).toBe("launch_2026.v-2");
    expect(sanitizeTouchValue("x".repeat(500))).toHaveLength(120);
    expect(sanitizeTouchValue("!!! ")).toBeUndefined();
    expect(sanitizeTouchValue("ünïcödé")).toBe("ncd");
    expect(sanitizeTouchValue(42)).toBeUndefined();
  });

  it("the middleware cookie is sanitized, 30 days, SameSite=Lax, Secure, path /", async () => {
    const set = ftSetCookie(await visit(`${SITE}/?utm_source=${"A".repeat(300)}&utm_medium=D%20M%3B%20evil%3D1&utm_campaign=%3Cb%3E`))!;
    expect(FT_MAX_AGE).toBe(30 * 24 * 60 * 60);
    expect(set).toMatch(/Max-Age=2592000/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/;\s*Secure/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/HttpOnly/i);
    const t = parseTouchCookie(cookiePair(set).slice(FT_COOKIE.length + 1));
    expect(t).toEqual({ utmSource: "a".repeat(120), utmMedium: "dmevil1", utmCampaign: "b" });
  });

  it("a tampered cookie is sanitized again on read, by the page and by the register route", async () => {
    const tampered = `${FT_COOKIE}=${encodeURIComponent("utm_source=Evil Corp<x>&referrer=calltrainer.tech&utm_term=" + "z".repeat(400))}`;
    expect(touchForRegister(tampered, "")).toEqual({ utmSource: "evilcorpx", utmTerm: "z".repeat(120) });
    const { user } = await signUp({}, tampered);
    expect(user).toMatchObject({ utmSource: "evilcorpx", utmTerm: "z".repeat(120) });
    expect(user.referrer).toBeUndefined();
  });

  it("bad and oversized register fields are sanitized, not rejected", async () => {
    const { res, user } = await signUp({ utmSource: "  LinkedIn  ", utmCampaign: "c".repeat(300), utmContent: "%%%", referrer: "https://news.ycombinator.com/item", utmTerm: null });
    expect(res.status).toBe(200);
    expect(user.utmSource).toBe("linkedin");
    expect(user.utmCampaign).toHaveLength(120);
    expect(user.utmContent).toBeUndefined();
    expect(user.referrer).toBe("news.ycombinator.com");
    expect(user.utmTerm).toBeUndefined();
    const payload = await ghlSignup(user.id);
    expect(payload.source!.length).toBeLessThanOrEqual(250);
  });
});

describe("registerHref passes the page's UTM tags through", () => {
  it("adds sanitized utm_* from the page after plan, seg and src, and drops everything else", () => {
    expect(registerHref({ plan: "pro", seg: "insurance", src: "insurance" }, `?${TAGGED}&utm_term=Cold%20Call&gclid=abc&src=evil`)).toBe(
      "/register?plan=pro&seg=insurance&src=insurance&utm_source=linkedin&utm_medium=dm&utm_campaign=launch-2026&utm_content=d1-dm01&utm_term=coldcall",
    );
    expect(registerHref({ src: "pricing" }, "?utm_source=%3Cx%3E")).toBe("/register?src=pricing&utm_source=x");
    expect(registerHref({ src: "pricing" }, "?ref=hn")).toBe("/register?src=pricing");
    expect(registerHref({ src: "pricing" })).toBe("/register?src=pricing");
  });

  it("withPageUtm only touches /register links and never replaces tags already on the link", () => {
    expect(withPageUtm("/register?src=x&utm_source=email", "?utm_source=linkedin&utm_medium=dm")).toBe("/register?src=x&utm_source=email&utm_medium=dm");
    expect(withPageUtm("/library", "?utm_source=linkedin")).toBe("/library");
    expect(withPageUtm("#plans", "?utm_source=linkedin")).toBe("#plans");
    expect(withPageUtm("/register?src=x", "")).toBe("/register?src=x");
  });

  it("the /for/saas-sdr CTA sends seg=saas-sdr", () => {
    expect(LANDINGS["saas-sdr"].primaryHref).toBe("/register?seg=saas-sdr&src=saas-sdr");
    expect(LANDINGS["saas-sdr"].seg).toBe("saas-sdr");
    expect(registerHref({ seg: LANDINGS["saas-sdr"].seg, src: "saas-sdr" }, "?utm_source=linkedin")).toBe("/register?seg=saas-sdr&src=saas-sdr&utm_source=linkedin");
  });
});
