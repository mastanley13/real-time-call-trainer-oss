import type { Config } from "tailwindcss";

/** Colors are CSS variables (RGB triplets) defined in globals.css, so the daylight desk, the dark theme and the night stage share one set of names. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: v("bg"),
        surface: v("surface"),
        sunken: v("sunken"),
        ink: { DEFAULT: v("ink"), soft: v("ink-soft"), muted: v("ink-muted") },
        line: { DEFAULT: v("line"), strong: v("line-strong") },
        primary: { DEFAULT: v("primary"), hover: v("primary-hover"), soft: v("primary-soft"), on: v("on-primary") },
        signal: v("signal"),
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") },
        caution: { DEFAULT: v("caution"), soft: v("caution-soft") },
        alert: { DEFAULT: v("alert"), soft: v("alert-soft"), on: v("on-alert") },
        // The caller's light and the stage's warm marks. Same in every theme.
        candle: v("light-candle"),
        amber: v("light-gold"),
        // Legacy aliases kept so untouched screens (auth, settings) pick up the new palette.
        accent: { DEFAULT: v("signal"), hover: v("primary-hover"), soft: v("primary-soft"), dark: v("primary"), darker: v("primary-hover") },
      },
      fontFamily: {
        // Radio Canada Big sets every word (Stage and Desk). Numbers use its tabular figures (.mono and tabular-nums);
        // there is no separate monospace font.
        heading: ["var(--font-radio)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-radio)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-radio)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: { panel: "16px", sheet: "24px" },
      boxShadow: {
        card: "0 1px 2px rgb(var(--shadow) / 0.06)",
        pop: "0 1px 2px rgb(var(--shadow) / 0.08), 0 18px 44px -18px rgb(var(--shadow) / 0.35)",
        glow: "0 0 0 1px rgb(var(--signal) / 0.55), 0 0 22px -4px rgb(var(--signal) / 0.45)",
        "inner-top": "inset 0 1px 0 rgb(255 255 255 / 0.04)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        "cue-in": { from: { opacity: "0", transform: "translateX(12px)" }, to: { opacity: "1", transform: "none" } },
        "lamp-pulse": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.45" } },
        "orb-breathe": { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.04)" } },
        "orb-talk": { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.08)" } },
        shimmer: { from: { backgroundPosition: "200% 0" }, to: { backgroundPosition: "-200% 0" } },
      },
      animation: {
        "fade-up": "fade-up .3s ease-out both",
        "cue-in": "cue-in .2s ease-out both",
        "lamp-pulse": "lamp-pulse 1.6s ease-in-out infinite",
        "orb-breathe": "orb-breathe 3.2s ease-in-out infinite",
        "orb-talk": "orb-talk .9s ease-in-out infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
