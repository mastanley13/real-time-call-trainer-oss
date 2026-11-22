import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wantsTextMode } from "@/lib/trainerQuery";

const q = (s: string) => new URLSearchParams(s);

describe("wantsTextMode", () => {
  it("is true only for mode=text exactly", () => {
    expect(wantsTextMode(q("scenario=auto-inbound-used-crossover-lead&mode=text"))).toBe(true);
    expect(wantsTextMode(q("mode=text"))).toBe(true);
  });

  it.each(["", "scenario=x", "mode=voice", "mode=Text", "mode=TEXT", "mode=text%20", "mode=", "mode=chat", "Mode=text"])("is false for ?%s", (s) => {
    expect(wantsTextMode(q(s))).toBe(false);
  });

  it("the trainer reads it in the idle-phase query effect, alongside the first-load mode pick", () => {
    const src = readFileSync("src/components/TrainerClient.tsx", "utf8");
    expect(src).toContain('useState<Mode>("voice")');
    expect(src).toContain('if (wantsTextMode(params)) setMode("text");');
    // Inside the effect that also reads ?scenario=. The first load decides the mode once (initialCallMode, which
    // returns Text for a first-time rep; see tests/launch-fixes.test.ts).
    const effect = src.slice(src.indexOf('if (phaseRef.current !== "idle") return;'), src.indexOf("}, [query]);"));
    expect(effect).toContain("wantsTextMode(params)");
    expect(effect).toContain("initialCallMode({ textParam: wantsTextMode(params), saved, hasPracticed })");
    expect(effect).toContain('params.get("scenario")');
  });
});
