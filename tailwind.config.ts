import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#F8FAFC",
        ink: { DEFAULT: "#071827", soft: "#334155", muted: "#526077" },
        primary: { DEFAULT: "#1D4ED8", hover: "#1E40AF", soft: "#DBEAFE" },
        accent: { DEFAULT: "#14B8A6", hover: "#0D9488", soft: "#CCFBF1", dark: "#0F766E", darker: "#115E59" },
        line: "#E2E8F0",
      },
      fontFamily: {
        heading: ["var(--font-sora)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(7,24,39,0.04), 0 8px 24px -12px rgba(7,24,39,0.12)",
        pop: "0 1px 2px rgba(7,24,39,0.06), 0 16px 40px -16px rgba(7,24,39,0.22)",
        orb: "0 20px 60px -20px rgba(29,78,216,0.55)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        "orb-breathe": { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.04)" } },
        "orb-talk": { "0%,100%": { transform: "scale(1)" }, "50%": { transform: "scale(1.08)" } },
        shimmer: { from: { backgroundPosition: "200% 0" }, to: { backgroundPosition: "-200% 0" } },
      },
      animation: {
        "fade-up": "fade-up .35s ease-out both",
        "orb-breathe": "orb-breathe 3.2s ease-in-out infinite",
        "orb-talk": "orb-talk .9s ease-in-out infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
