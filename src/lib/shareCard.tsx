import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

export type SharePalette = { bg: string; ink: string; inkSoft: string; signal: string };

/** Reads the deck (dark) token block of globals.css and returns CSS colors. ImageResponse cannot resolve CSS variables, so the tokens are read from the stylesheet. */
export function paletteFromCss(css: string): SharePalette {
  const block = /\.deck,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
  if (!block) throw new Error("globals.css has no .deck token block");
  const token = (name: string) => {
    const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`).exec(block);
    if (!m) throw new Error(`globals.css .deck block has no --${name} token`);
    return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  };
  return { bg: token("bg"), ink: token("ink"), inkSoft: token("ink-soft"), signal: token("signal") };
}

let palette: SharePalette | undefined;
function sharePalette(): SharePalette {
  palette ??= paletteFromCss(readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8"));
  return palette;
}

/** Share card for Open Graph and Twitter: brand name plus one headline, text only, colored from the deck tokens. */
export function renderShareCard(headline = "Practice the call before it costs you the deal") {
  const c = sharePalette();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: c.bg, color: c.ink }}>
        <div style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: c.signal }} />
        <div style={{ display: "flex", marginTop: 40, fontSize: 40, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: c.inkSoft }}>Real-Time Call Trainer</div>
        <div style={{ display: "flex", marginTop: 28, fontSize: headline.length > 60 ? 68 : 80, fontWeight: 700, letterSpacing: -2, lineHeight: 1.1 }}>{headline}</div>
      </div>
    ),
    SHARE_CARD_SIZE,
  );
}
