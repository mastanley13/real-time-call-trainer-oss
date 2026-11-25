import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config as proxyConfig } from "@/proxy";

const FILE = join(__dirname, "..", "public", "llms.txt");
const LIVE_COMPARE = [
  "https://calltrainer.tech/vs/second-nature",
  "https://calltrainer.tech/vs/hyperbound",
  "https://calltrainer.tech/vs/yoodli",
  "https://calltrainer.tech/alternatives",
];

function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    out[part.slice(0, nl).trim()] = part.slice(nl + 1);
  }
  return out;
}

describe("public/llms.txt", () => {
  it("exists in public so it is served at /llms.txt", () => {
    expect(existsSync(FILE)).toBe(true);
  });

  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const s = sections(text);
  const live = s["Live pages"] ?? "";
  const planned = Object.entries(s).find(([k]) => k.startsWith("Planned pages"))?.[1] ?? "";

  it("lists the comparison pages and the alternatives hub as live, not planned", () => {
    for (const url of LIVE_COMPARE) {
      expect(live).toContain(`(${url})`);
      expect(planned).not.toContain(url);
    }
  });

  it("lists /library and /compete as live", () => {
    expect(live).toContain("(https://calltrainer.tech/library)");
    expect(live).toContain("(https://calltrainer.tech/compete)");
  });

  it("is dated 25 November 2026 and keeps genuinely planned pages in Planned", () => {
    expect(text).toContain("as of 25 November 2026");
    expect(text).not.toContain("21 November 2026");
    expect(planned).toContain("https://calltrainer.tech/for/911)");
    expect(live).not.toContain("/for/911");
    expect(live).not.toContain("/blog/");
  });

  it("uses no em dashes", () => {
    expect(text).not.toContain("—");
  });

  it("is not caught by the access gate (the proxy skips paths with a file extension)", () => {
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matcher.test("/llms.txt")).toBe(false);
    expect(matcher.test("/library")).toBe(true);
  });
});
