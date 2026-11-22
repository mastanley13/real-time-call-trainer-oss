import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

import TryPage, { dynamicParams, generateMetadata, generateStaticParams } from "@/app/try/[role]/page";
import sitemap from "@/app/sitemap";
import { LIBRARY } from "@/lib/personas";
import { safeNextPath } from "@/lib/safeNext";
import {
  TRY_DEMO_LABEL, TRY_PRIMARY_LABEL, TRY_ROLE_SLUGS, TRY_ROLES, tryDemoHref, tryNextPath, tryRegisterHref, tryRole, utmParams,
} from "@/lib/tryRoles";

const EXPECTED = {
  dealership: {
    headline: "Practice an internet-lead callback against an AI buyer who pushes back.",
    bullets: ["An AI buyer who objects and changes the subject.", "A live coach on the call.", "A graded debrief that quotes the transcript."],
    persona: "auto-inbound-used-crossover-lead",
  },
  "real-estate": {
    headline: "Practice a portal-lead callback against an AI buyer who pushes back.",
    bullets: ["An AI buyer inquiring about a listing.", "A live coach on the call.", "A graded debrief that quotes the transcript."],
    persona: "real-estate-portal-buyer-inquiry",
  },
  staffing: {
    headline: "Practice a candidate screen against an AI candidate who pushes back.",
    bullets: ["An AI candidate who is evaluating you too.", "A live coach on the call.", "A graded debrief that quotes the transcript."],
    persona: "recruiting-active-candidate-support-lead",
  },
  insurance: {
    headline: "Practice an inbound auto quote against an AI buyer who pushes back.",
    bullets: ["An AI buyer shopping a first policy.", "A live coach on the call.", "A graded debrief that quotes the transcript."],
    persona: "insurance-first-solo-auto-quote",
  },
} as const;

const render = async (role: string) => renderToStaticMarkup(await TryPage({ params: Promise.resolve({ role }) }));
/** The href of the link with this exact label, with HTML entities in the attribute undone. */
const hrefOf = (html: string, label: string) => {
  const attrs = new RegExp(`<a([^>]*)>${label}</a>`).exec(html)?.[1] ?? "";
  return (/href="([^"]*)"/.exec(attrs)?.[1] ?? "").replace(/&amp;/g, "&");
};
const parse = (href: string) => new URL(href, "http://same-site.invalid");

beforeEach(() => { mocks.query = ""; });

describe("/try/[role] routing", () => {
  it("lists exactly the four slugs and nothing else", () => {
    expect([...TRY_ROLE_SLUGS]).toEqual(["dealership", "real-estate", "staffing", "insurance"]);
    expect(generateStaticParams()).toEqual(TRY_ROLE_SLUGS.map((role) => ({ role })));
    expect(Object.keys(TRY_ROLES).sort()).toEqual([...TRY_ROLE_SLUGS].sort());
  });

  it("does not render unknown roles at request time", () => {
    expect(dynamicParams).toBe(false);
  });

  it.each(["unknown", "dealer", "Dealership", "constructor", "__proto__", "toString", ""])("calls notFound for %j", async (role) => {
    expect(tryRole(role)).toBeUndefined();
    await expect(render(role)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the page source guards with notFound, not a redirect", () => {
    const src = readFileSync("src/app/try/[role]/page.tsx", "utf8");
    expect(src).toContain("if (!r) notFound();");
    expect(src).not.toMatch(/redirect\(/);
  });

  it("sets title, description and the canonical /try path; nothing for an unknown role", async () => {
    for (const slug of TRY_ROLE_SLUGS) {
      const m = await generateMetadata({ params: Promise.resolve({ role: slug }) });
      expect(m.title).toEqual({ absolute: TRY_ROLES[slug].title });
      expect(m.description).toBe(TRY_ROLES[slug].description);
      expect(String(m.alternates?.canonical)).toMatch(new RegExp(`/try/${slug}$`));
    }
    expect(await generateMetadata({ params: Promise.resolve({ role: "unknown" }) })).toEqual({});
  });

  it("lists the four pages in the sitemap", () => {
    const urls = sitemap().map((e) => e.url);
    for (const slug of TRY_ROLE_SLUGS) expect(urls.some((u) => u.endsWith(`/try/${slug}`)), slug).toBe(true);
  });
});

describe("/try/[role] page", () => {
  it.each([...TRY_ROLE_SLUGS])("%s renders its headline, three bullets and both buttons", async (slug) => {
    const e = EXPECTED[slug];
    const html = await render(slug);
    expect(html).toContain(e.headline);
    for (const b of e.bullets) expect(html).toContain(b);
    expect(html).toContain(`>${TRY_PRIMARY_LABEL}</a>`);
    expect(html).toContain(`>${TRY_DEMO_LABEL}</a>`);
    expect(TRY_PRIMARY_LABEL).toBe("Start free practice");
    expect(TRY_DEMO_LABEL).toBe("Book a demo for your team");
  });

  it.each([...TRY_ROLE_SLUGS])("%s sends Start free practice to /register with the persona and mode=text in next", async (slug) => {
    const href = hrefOf(await render(slug), TRY_PRIMARY_LABEL);
    const reg = parse(href);
    expect(reg.pathname).toBe("/register");
    const next = reg.searchParams.get("next")!;
    expect(safeNextPath(next)).toBe(next);
    const n = parse(next);
    expect(n.pathname).toBe("/trainer");
    expect(n.searchParams.get("scenario")).toBe(EXPECTED[slug].persona);
    expect(n.searchParams.get("mode")).toBe("text");
    expect(hrefOf(await render(slug), TRY_DEMO_LABEL)).toBe("/demo");
  });

  it("copies utm_* from the current URL onto both buttons and into next, and drops other params", async () => {
    mocks.query = "utm_source=coldemail&utm_campaign=q4-bdc&ref=partner&UTM_medium=caps";
    const html = await render("dealership");
    const reg = parse(hrefOf(html, TRY_PRIMARY_LABEL));
    expect(reg.searchParams.get("utm_source")).toBe("coldemail");
    expect(reg.searchParams.get("utm_campaign")).toBe("q4-bdc");
    expect(reg.searchParams.has("ref")).toBe(false);
    expect(reg.searchParams.has("UTM_medium")).toBe(false);
    const next = parse(reg.searchParams.get("next")!);
    expect(next.searchParams.get("scenario")).toBe("auto-inbound-used-crossover-lead");
    expect(next.searchParams.get("mode")).toBe("text");
    expect(next.searchParams.get("utm_source")).toBe("coldemail");
    expect(next.searchParams.get("utm_campaign")).toBe("q4-bdc");
    expect(hrefOf(html, TRY_DEMO_LABEL)).toBe("/demo?utm_source=coldemail&utm_campaign=q4-bdc");
  });

  it("every persona pick exists in the library", () => {
    const ids = new Set(LIBRARY.map((s) => s.id));
    for (const slug of TRY_ROLE_SLUGS) {
      expect(TRY_ROLES[slug].personaId).toBe(EXPECTED[slug].persona);
      expect(ids.has(TRY_ROLES[slug].personaId), slug).toBe(true);
    }
  });
});

describe("utm passthrough helpers", () => {
  const role = TRY_ROLES.insurance;

  it("keeps utm_ keys only (case-sensitive prefix), in order", () => {
    expect(utmParams(new URLSearchParams("utm_source=a&x=1&utm_campaign=b&Utm_term=c&utm=d"))).toEqual([["utm_source", "a"], ["utm_campaign", "b"]]);
    expect(utmParams(null)).toEqual([]);
  });

  it("builds both hrefs with the utm keys, and the encoded next carries them too", () => {
    const utm = utmParams(new URLSearchParams("utm_source=newsletter&utm_campaign=fall&gclid=zzz"));
    const reg = parse(tryRegisterHref(role, utm));
    expect(reg.searchParams.get("utm_source")).toBe("newsletter");
    expect(reg.searchParams.get("utm_campaign")).toBe("fall");
    expect(reg.searchParams.has("gclid")).toBe(false);
    expect(reg.searchParams.get("next")).toBe("/trainer?scenario=insurance-first-solo-auto-quote&mode=text&utm_source=newsletter&utm_campaign=fall");
    expect(tryDemoHref(utm)).toBe("/demo?utm_source=newsletter&utm_campaign=fall");
  });

  it("without utm keys the hrefs are plain", () => {
    expect(tryRegisterHref(role)).toBe("/register?next=%2Ftrainer%3Fscenario%3Dinsurance-first-solo-auto-quote%26mode%3Dtext");
    expect(tryDemoHref()).toBe("/demo");
  });

  it("drops oversized values, and fills next with utm pairs in order up to the safeNextPath limit", () => {
    expect(utmParams(new URLSearchParams(`utm_source=${"x".repeat(500)}`))).toEqual([]);
    const base = "/trainer?scenario=recruiting-active-candidate-support-lead&mode=text";
    const long = utmParams(new URLSearchParams(Array.from({ length: 8 }, (_, i) => `utm_k${i}=${"v".repeat(100)}`).join("&")));
    const next = tryNextPath(TRY_ROLES.staffing, long);
    // The first pair fits (68 + 108 chars); the second would pass 200, so it and everything after stay out.
    expect(next).toBe(`${base}&utm_k0=${"v".repeat(100)}`);
    expect(next.length).toBeLessThanOrEqual(200);
    expect(safeNextPath(next)).toBe(next);
    // Every utm key still rides on /register itself.
    const reg = parse(tryRegisterHref(TRY_ROLES.staffing, long));
    for (let i = 0; i < 8; i++) expect(reg.searchParams.get(`utm_k${i}`)).toBe("v".repeat(100));
    expect(parse(reg.searchParams.get("next")!).searchParams.has("utm_k1")).toBe(false);
  });

  it("stops at the first pair that does not fit, so a later short pair is not added out of order", () => {
    const base = "/trainer?scenario=recruiting-active-candidate-support-lead&mode=text";
    const utm: [string, string][] = [["utm_a", "1"], ["utm_b", "x".repeat(120)], ["utm_c", "2"]];
    expect(tryNextPath(TRY_ROLES.staffing, utm)).toBe(`${base}&utm_a=1`);
    // Nothing fits: just the persona and mode.
    expect(tryNextPath(TRY_ROLES.staffing, [["utm_b", "x".repeat(150)], ["utm_c", "2"]])).toBe(base);
  });
});

describe("try copy rules", () => {
  it.each(["src/lib/tryRoles.ts", "src/app/try/[role]/page.tsx", "src/components/landing/TryActions.tsx"])("%s has no em or en dashes", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
  });
});
