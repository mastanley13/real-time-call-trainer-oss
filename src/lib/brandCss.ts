/**
 * Tenant brand colors: CSS that replaces the primary tokens, plus the contrast checks the prebuild runs on them.
 * Ported from the AirPets brand layer; the base tokens come from THEME_TOKENS (src/lib/themeTokens.ts) instead of
 * hand-copied numbers. Pure and client-safe. The default tenant sets no theme color, so brandCss() returns "".
 */
import { THEME_TOKENS, type Rgb } from "./themeTokens";

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** Button text on a dark-enough fill: the daylight ink. Soft fills in the dark theme mix toward the deck background. */
const INK = THEME_TOKENS.light.ink;
const DECK_BG = THEME_TOKENS.dark.bg;

/** Strict "#rrggbb" (lowercase or uppercase) or "rrggbb". Anything else is null. */
export function hexToRgb(hex: string | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as unknown as Rgb;

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or ink, whichever reads better on a filled primary button. */
export const onColor = (c: Rgb): Rgb => (contrast(c, WHITE) >= contrast(c, INK) ? WHITE : INK);

/** The dark-theme primary: the explicit dark color, else a lighter shade of the light one. */
export function darkPrimary(lightHex?: string, darkHex?: string): Rgb | null {
  const light = hexToRgb(lightHex);
  return hexToRgb(darkHex) ?? (light ? mix(light, WHITE, 0.45) : null);
}

function tokens(p: Rgb, dark: boolean): Record<string, Rgb> {
  return dark
    ? { primary: p, "primary-hover": mix(p, WHITE, 0.3), "primary-soft": mix(p, DECK_BG, 0.78), "on-primary": onColor(p), signal: p }
    : { primary: p, "primary-hover": mix(p, BLACK, 0.18), "primary-soft": mix(p, WHITE, 0.88), "on-primary": onColor(p), signal: mix(p, WHITE, 0.12) };
}

const declarations = (t: Record<string, Rgb>) => Object.entries(t).map(([k, v]) => `--${k}:${v.join(" ")}`).join(";");

/**
 * CSS that replaces the primary color tokens from globals.css. Without a dark color, the dark theme and the call deck
 * use a lighter shade of the light one. Each selector has an extra `html`, so it outranks the default it overrides
 * wherever the style tag lands. Returns "" when neither color is a valid #rrggbb value.
 */
export function brandCss(lightHex?: string, darkHex?: string): string {
  const light = hexToRgb(lightHex);
  const dark = darkPrimary(lightHex, darkHex);
  let css = "";
  if (light) css += `html:root{${declarations(tokens(light, false))}}`;
  if (dark) {
    const d = declarations(tokens(dark, true));
    css += `html .deck,html:root[data-theme="dark"]{${d}}@media (prefers-color-scheme:dark){html:root:not([data-theme="light"]){${d}}}`;
  }
  // Print always uses daylight values, the debrief deck included (see globals.css). Last, so it beats the dark rules
  // above at equal specificity.
  if (light) css += `@media print{html:root,html .deck,html:root[data-theme="dark"],html:root:not([data-theme="light"]){${declarations(tokens(light, false))}}}`;
  return css;
}

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_UI_CONTRAST = 3;

const ratio = (n: number) => `${n.toFixed(2)}:1`;

/**
 * Contrast problems for a tenant theme, each naming the config key to change. Empty means the colors pass:
 * button text on the fill is at least 4.5:1, and the fill against the page and surface is at least 3:1, in
 * daylight, dark and the call deck (which share the dark tokens).
 */
export function themeContrastProblems(theme: { primary?: string; primaryDark?: string }): string[] {
  const problems: string[] = [];
  const light = hexToRgb(theme.primary);
  const dark = darkPrimary(theme.primary, theme.primaryDark);
  const darkKey = theme.primaryDark ? "theme.primaryDark" : "theme.primary (derived dark shade; set theme.primaryDark)";
  const check = (key: string, c: Rgb, scheme: "light" | "dark", label: string) => {
    const t = THEME_TOKENS[scheme];
    const text = contrast(c, onColor(c));
    if (text < MIN_TEXT_CONTRAST) problems.push(`${key}: button text on the ${label} primary is ${ratio(text)}, below ${MIN_TEXT_CONTRAST}:1`);
    for (const bg of ["bg", "surface"] as const) {
      const ui = contrast(c, t[bg]);
      if (ui < MIN_UI_CONTRAST) problems.push(`${key}: primary against the ${label} ${bg === "bg" ? "background" : "surface"} is ${ratio(ui)}, below ${MIN_UI_CONTRAST}:1`);
    }
  };
  if (light) check("theme.primary", light, "light", "daylight");
  // The call deck uses the dark tokens (globals.css), so one check covers both.
  if (dark) check(darkKey, dark, "dark", "dark theme and call deck");
  return problems;
}
