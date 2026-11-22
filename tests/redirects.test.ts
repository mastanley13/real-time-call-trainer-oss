import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

const DEMO_URL = "https://api.leadconnectorhq.com/widget/bookings/calltrainer-demo";

async function load() {
  expect(nextConfig.redirects).toBeTypeOf("function");
  return (await nextConfig.redirects!()) as Array<{
    source: string;
    destination: string;
    permanent: boolean;
  }>;
}

describe("redirects", () => {
  it("sends /for/911 and /for/911/ to /demo as a temporary redirect", async () => {
    const rules = await load();
    for (const source of ["/for/911", "/for/911/"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toBeDefined();
      expect(rule!.destination).toBe("/demo");
      expect(rule!.permanent).toBe(false);
    }
  });

  it("keeps the existing /demo redirects unchanged", async () => {
    const rules = await load();
    for (const source of ["/demo", "/demo/"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toBeDefined();
      expect(rule!.destination).toBe(DEMO_URL);
      expect(rule!.permanent).toBe(false);
    }
  });
});
