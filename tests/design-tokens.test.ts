import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Stage and Desk: deterministic contrast checks on the ACTUAL color tokens in src/app/globals.css, for the daylight
 * desk (:root), the dark desk (.deck and the dark theme) and the night stage (.stage, the live call and the debrief
 * verdict). This measures token pairs with the WCAG 2.x formula; it is not a rendered-page audit.
 */
const css = readFileSync("src/app/globals.css", "utf8");
type RGB = [number, number, number];

function block(re: RegExp): Record<string, RGB> {
  const body = css.match(re)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(\d+) (\d+) (\d+);/g)].map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])] as RGB]));
}
const light = block(/:root \{([^}]*)\}/);
const dark = block(/\.deck,\s*:root\[data-theme="dark"\] \{([^}]*)\}/);
const darkSystem = block(/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/);
const stage = block(/\.stage \{([^}]*)\}/);
const schemes = [["light", light], ["dark", dark], ["stage", stage]] as const;

const lum = ([r, g, b]: RGB) => {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** `top` at `alpha` composited over an opaque `base`, as a Tailwind `bg-x/60` renders on that base. */
const over = (top: RGB, alpha: number, base: RGB): RGB => [0, 1, 2].map((i) => Math.round(top[i] * alpha + base[i] * (1 - alpha))) as RGB;

const COLOR_TOKENS = ["bg", "surface", "sunken", "ink", "ink-soft", "ink-muted", "line", "line-strong", "primary", "primary-hover", "primary-soft", "on-primary",
  "signal", "ok", "ok-soft", "caution", "caution-soft", "alert", "alert-soft", "on-alert", "shadow"];

describe("design tokens: every scheme defines every color", () => {
  for (const [name, set] of schemes) {
    it(`${name} defines the full set`, () => {
      for (const t of COLOR_TOKENS) expect(set[t], `${name} --${t}`).toBeDefined();
    });
  }
  it("the dark theme from the system matches the dark toggle exactly", () => {
    expect(darkSystem).toEqual(dark);
  });
  it("the caller's light is defined once, for every theme and scope", () => {
    for (const t of ["light-candle", "light-gold", "light-deep"]) expect(light[t], t).toBeDefined();
  });
  it("the stage never follows the theme: no theme rule redefines .stage", () => {
    expect(css).not.toMatch(/data-theme[^{]*\.stage/);
  });
});

describe("design tokens: contrast (WCAG AA, measured from globals.css)", () => {
  for (const [name, set] of schemes) {
    it(`${name}: body, soft and muted text are at least 4.5:1 on every surface`, () => {
      for (const text of ["ink", "ink-soft", "ink-muted"]) for (const surface of ["bg", "surface", "sunken"]) {
        expect(contrast(set[text], set[surface]), `${name}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: status and action colors used as text are at least 4.5:1 on panels and the page`, () => {
      for (const text of ["primary", "ok", "caution", "alert"]) for (const surface of ["bg", "surface"]) {
        expect(contrast(set[text], set[surface]), `${name}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: button text is at least 4.5:1 on its fill`, () => {
      expect(contrast(set["on-primary"], set.primary), `${name}: on-primary on primary`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set["on-alert"], set.alert), `${name}: on-alert on alert`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: tinted rows keep their text readable (score chips, the objection row, the Now step)`, () => {
      expect(contrast(set.ok, set["ok-soft"]), `${name}: ok on ok-soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set.alert, set["alert-soft"]), `${name}: alert on alert-soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set.alert, over(set["alert-soft"], 0.6, set.bg)), `${name}: alert on alert-soft/60 over bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set.ink, over(set["primary-soft"], 0.7, set.surface)), `${name}: ink on primary-soft/70`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(set.ink, set["caution-soft"]), `${name}: ink on caution-soft`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: the focus ring and strong rules are visible (3:1) on every surface`, () => {
      for (const surface of ["bg", "surface", "sunken"]) expect(contrast(set.primary, set[surface]), `${name}: primary ring on ${surface}`).toBeGreaterThanOrEqual(3);
    });
  }

  it("the stage is darker than the dark desk, so the call reads as night inside a dark theme too", () => {
    expect(lum(stage.bg)).toBeLessThan(lum(dark.bg));
  });
});
