import { describe, expect, it } from "vitest";
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
