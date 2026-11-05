/**
 * The Flight Deck color tokens as data: the same RGB triplets as src/app/globals.css, in one table, so the tenant
 * brand CSS (src/lib/brandCss.ts) and its contrast checks read them from one place instead of copying numbers.
 * tests/tenant-brand.test.ts fails if this table and globals.css drift apart. Change both together.
 *
 * Pure and client-safe. This file and the CSS that brandCss() generates from it are the one allowed numeric-color
 * path in TypeScript (see AGENTS.md, "Design tokens only"); components still use the Tailwind token names.
 */

export type Rgb = readonly [number, number, number];

export const TOKEN_NAMES = [
  "bg", "surface", "sunken", "ink", "ink-soft", "ink-muted", "line",
  "primary", "primary-hover", "primary-soft", "on-primary", "signal",
  "ok", "ok-soft", "caution", "caution-soft", "alert", "alert-soft", "on-alert", "shadow",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

/** Daylight (`:root`) and the deck, which is also the dark theme (`.deck`, `[data-theme="dark"]`, `prefers-color-scheme`). */
export const THEME_TOKENS: { light: Record<TokenName, Rgb>; dark: Record<TokenName, Rgb> } = {
  light: {
    bg: [245, 247, 251],
    surface: [255, 255, 255],
    sunken: [236, 240, 246],
    ink: [11, 18, 32],
    "ink-soft": [51, 65, 85],
    "ink-muted": [82, 96, 119],
    line: [220, 227, 238],
    primary: [14, 116, 144],
    "primary-hover": [21, 94, 117],
    "primary-soft": [207, 250, 254],
    "on-primary": [255, 255, 255],
    signal: [8, 145, 178],
    ok: [4, 120, 87],
    "ok-soft": [209, 250, 229],
    caution: [180, 83, 9],
    "caution-soft": [254, 243, 199],
    alert: [220, 38, 38],
    "alert-soft": [254, 226, 226],
    "on-alert": [255, 255, 255],
    shadow: [11, 18, 32],
  },
  dark: {
    bg: [10, 15, 26],
    surface: [17, 26, 43],
    sunken: [13, 20, 34],
    ink: [230, 238, 249],
    "ink-soft": [184, 198, 220],
    "ink-muted": [138, 155, 184],
    line: [36, 49, 77],
    primary: [34, 211, 238],
    "primary-hover": [103, 232, 249],
    "primary-soft": [22, 52, 66],
    "on-primary": [4, 34, 43],
    signal: [34, 211, 238],
    ok: [52, 211, 153],
    "ok-soft": [14, 52, 44],
    caution: [251, 191, 36],
    "caution-soft": [58, 44, 12],
    alert: [248, 113, 113],
    "alert-soft": [64, 24, 28],
    "on-alert": [35, 6, 6],
    shadow: [0, 0, 0],
  },
};
