import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import nextConfig from "../next.config";

// /contact is a temporary redirect to /demo until a contact page exists. The /demo booking redirect stays as it is.
async function redirects() {
  const list = await nextConfig.redirects?.();
  if (!list) throw new Error("next.config has no redirects");
  return list;
}

describe("/contact redirect", () => {
  it("/contact and /contact/ give a temporary redirect to /demo", async () => {
    const list = await redirects();
    for (const source of ["/contact", "/contact/"]) {
      const r = list.filter((x) => x.source === source);
      expect(r, source).toHaveLength(1);
      expect(r[0]).toMatchObject({ source, destination: "/demo", permanent: false });
    }
  });

  it("the /demo redirects are still there and come before /contact", async () => {
    const list = await redirects();
    const sources = list.map((x) => x.source);
    for (const source of ["/demo", "/demo/"]) {
      const r = list.find((x) => x.source === source);
      expect(r, source).toMatchObject({ permanent: false });
      expect(r?.destination).toMatch(/^https:\/\//);
      expect(sources.indexOf(source)).toBeLessThan(sources.indexOf("/contact"));
    }
  });

  it("the /for/911 redirects are still there, each once, and come before /contact", async () => {
    const list = await redirects();
    const sources = list.map((x) => x.source);
    for (const source of ["/for/911", "/for/911/"]) {
      const r = list.filter((x) => x.source === source);
      expect(r, source).toHaveLength(1);
      expect(r[0]).toMatchObject({ source, destination: "/demo", permanent: false });
      expect(sources.indexOf(source)).toBeLessThan(sources.indexOf("/contact"));
    }
  });
});

// /signup is a permanent redirect to /register: old links and ads point at /signup. The query string must survive.
describe("/signup redirect", () => {
  const SIGNUP = ["/signup", "/signup/"];

  /** The first redirect whose source matches the path, as Next.js picks it (strict matching, first match wins). */
  async function firstMatch(path: string) {
    return (await redirects()).find((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false);
  }

  it("/signup and /signup/ each appear once, permanent (308), to /register, with no has or missing rule", async () => {
    const list = await redirects();
    for (const source of SIGNUP) {
      const r = list.filter((x) => x.source === source);
      expect(r, source).toHaveLength(1);
      expect(r[0]).toMatchObject({ source, destination: "/register", permanent: true });
      expect(r[0]).not.toHaveProperty("has");
      expect(r[0]).not.toHaveProperty("missing");
      expect(r[0]).not.toHaveProperty("statusCode");
    }
  });

  it("sit right after the /contact entries, after main's /demo and /for/911 entries", async () => {
    const sources = (await redirects()).map((x) => x.source);
    const at = (s: string) => sources.indexOf(s);
    expect(at("/signup")).toBe(at("/contact/") + 1);
    expect(at("/signup/")).toBe(at("/signup") + 1);
    for (const earlier of ["/demo", "/demo/", "/for/911", "/for/911/", "/contact", "/contact/"]) {
      expect(at(earlier), earlier).toBeGreaterThanOrEqual(0);
      expect(at(earlier), earlier).toBeLessThan(at("/signup"));
    }
  });

  it("nothing overrides them: the first matching redirect for /signup and /signup/ is the /signup entry", async () => {
    for (const path of SIGNUP) {
      expect(await firstMatch(path), path).toMatchObject({ destination: "/register", permanent: true });
    }
    // And they catch nothing else.
    for (const path of ["/register", "/signup/extra", "/sign-up"]) {
      expect((await firstMatch(path))?.destination, path).not.toBe("/register");
    }
  });

  it("keeps the query string: ?plan=pro&interval=year arrives at /register", async () => {
    for (const path of SIGNUP) {
      const rule = (await firstMatch(path))!;
      expect(rule.destination).not.toContain("?"); // no query of its own to override the incoming one
      const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(path) as Record<string, string>;
      // The function the Next.js router runs for a redirect: the incoming query is merged under the destination's own.
      const { parsedDestination } = prepareDestination({
        appendParamsToQuery: false,
        destination: rule.destination,
        params,
        query: { plan: "pro", interval: "year" },
      });
      expect(parsedDestination.pathname).toBe("/register");
      expect(parsedDestination.query).toEqual({ plan: "pro", interval: "year" });
    }
  });
});
