import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#F8FAFC",
        ink: { DEFAULT: "#071827", soft: "#334155", muted: "#64748B" },
        primary: { DEFAULT: "#1D4ED8", hover: "#1E40AF", soft: "#DBEAFE" },
        accent: { DEFAULT: "#14B8A6", hover: "#0D9488", soft: "#CCFBF1" },
        line: "#E2E8F0",
      },
      fontFamily: {
        heading: ["var(--font-sora)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(7,24,39,0.04), 0 8px 24px -12px rgba(7,24,39,0.12)",
      },
    },
  },
  plugins: [],
};
export default config;
