import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_LINKS } from "@/lib/legalLinks";

describe("legal links", () => {
  it("points at Privacy and Terms", () => {
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual(["/privacy", "/terms"]);
  });
  it("each link has a page", () => {
    for (const l of LEGAL_LINKS) {
      expect(existsSync(join(process.cwd(), "src/app", l.href, "page.tsx"))).toBe(true);
    }
  });
});
