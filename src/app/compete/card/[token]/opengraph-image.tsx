import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import LogoMark from "@/components/LogoMark";
import { COMPETITION_DEFAULT_TITLE, COMPETITION_MAX_ATTEMPTS, COMPETITION_TRACKS, type CompetitionShareCardData } from "@/lib/competition";
import { getCompetitionShareCard } from "@/lib/competitionServer";
import { siteUrl } from "@/lib/seo";
import { SHARE_CARD_SIZE } from "@/lib/shareCard";

export const alt = "Launch Sales Call Championship score card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

type CardPalette = Record<"bg" | "surface" | "sunken" | "ink" | "inkSoft" | "inkMuted" | "line" | "primary" | "primarySoft" | "onPrimary" | "signal" | "ok", string>;

/**
 * Reads the deck (dark) token block of globals.css, the same source src/lib/shareCard.tsx uses. ImageResponse cannot
 * resolve CSS variables, so the share card is colored from the stylesheet tokens instead of literals.
 */
function deckPalette(css: string): CardPalette {
  const block = /\.deck,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1];
  if (!block) throw new Error("globals.css has no .deck token block");
  const token = (name: string) => {
    const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`).exec(block);
    if (!m) throw new Error(`globals.css .deck block has no --${name} token`);
    return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  };
  return {
    bg: token("bg"), surface: token("surface"), sunken: token("sunken"), ink: token("ink"), inkSoft: token("ink-soft"), inkMuted: token("ink-muted"),
    line: token("line"), primary: token("primary"), primarySoft: token("primary-soft"), onPrimary: token("on-primary"), signal: token("signal"), ok: token("ok"),
  };
}

let palette: CardPalette | undefined;
function cardPalette(): CardPalette {
  palette ??= deckPalette(readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8"));
  return palette;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

function TopBar({ c, track }: { c: CardPalette; track?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <LogoMark size={56} />
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 20 }}>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: c.ink }}>Call Trainer</div>
          <div style={{ display: "flex", marginTop: 4, fontSize: 18, fontWeight: 700, letterSpacing: 3, color: c.signal }}>LAUNCH SALES CALL CHAMPIONSHIP</div>
        </div>
      </div>
      {track && (
        <div style={{ display: "flex", padding: "10px 24px", borderRadius: 999, border: `2px solid ${c.line}`, background: c.surface, color: c.inkSoft, fontSize: 24, fontWeight: 700 }}>
          {clip(track, 24)}
        </div>
      )}
    </div>
  );
}

function Footer({ c, lead, host }: { c: CardPalette; lead: string; host: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", width: "100%", paddingTop: 28, borderTop: `2px solid ${c.line}`, fontSize: 26, color: c.inkSoft }}>
      <div style={{ display: "flex" }}>{`${lead} Take ${COMPETITION_MAX_ATTEMPTS} free voice calls at`}</div>
      <div style={{ display: "flex", marginLeft: 10, color: c.signal, fontWeight: 700 }}>{`${host}/compete`}</div>
    </div>
  );
}

function ScoreCard({ c, card, host }: { c: CardPalette; card: CompetitionShareCardData; host: string }) {
  const name = clip(card.displayName, 28);
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "56px 72px", background: c.bg, color: c.ink }}>
      <TopBar c={c} track={card.trackLabel} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <div style={{ display: "flex", fontSize: 220, fontWeight: 700, lineHeight: 1, letterSpacing: -8, color: c.ink }}>{String(card.overallScore)}</div>
          <div style={{ display: "flex", marginLeft: 16, marginBottom: 28, fontSize: 56, fontWeight: 700, color: c.inkMuted }}>/ 100</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: 560 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", padding: "10px 22px", borderRadius: 999, background: c.primarySoft, color: c.primary, fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>
              {`#${card.overallRank} OVERALL`}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginLeft: 16, width: 104, height: 104, borderRadius: 24, background: c.primary, color: c.onPrimary, fontSize: 64, fontWeight: 700 }}>
              {clip(card.grade, 3)}
            </div>
          </div>
          <div style={{ display: "flex", marginTop: 28, fontSize: name.length > 18 ? 44 : 56, fontWeight: 700, color: c.ink, textAlign: "right" }}>{name}</div>
          {card.teamLabel && <div style={{ display: "flex", marginTop: 6, fontSize: 28, color: c.inkSoft }}>{clip(card.teamLabel, 36)}</div>}
          <div style={{ display: "flex", alignItems: "center", marginTop: 12, fontSize: 24, color: c.inkMuted }}>
            <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, marginRight: 10, background: card.goalAchieved ? c.ok : c.line }} />
            {`${card.goalAchieved ? "Goal achieved" : "Goal not reached"} vs. ${clip(card.buyerName, 24)}`}
          </div>
        </div>
      </div>
      <Footer c={c} lead={`Can you beat ${card.overallScore}?`} host={host} />
    </div>
  );
}

function FallbackCard({ c, host }: { c: CardPalette; host: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "56px 72px", background: c.bg, color: c.ink }}>
      <TopBar c={c} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: c.signal }} />
        <div style={{ display: "flex", marginTop: 32, fontSize: 80, fontWeight: 700, letterSpacing: -2, lineHeight: 1.1 }}>
          {`${COMPETITION_MAX_ATTEMPTS} calls. ${COMPETITION_TRACKS.length} industries. Prove it on the phone.`}
        </div>
        <div style={{ display: "flex", marginTop: 20, fontSize: 30, color: c.inkSoft }}>{COMPETITION_DEFAULT_TITLE}</div>
      </div>
      <Footer c={c} lead="Think you can top the board?" host={host} />
    </div>
  );
}

/** 1200x630 score card for Open Graph. Falls back to a plain championship card when the token has no card. */
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let card: CompetitionShareCardData | null = null;
  if (TOKEN_RE.test(token)) {
    try {
      card = await getCompetitionShareCard(token);
    } catch {
      card = null;
    }
  }
  const c = cardPalette();
  const host = new URL(siteUrl()).host;
  return new ImageResponse(card ? <ScoreCard c={c} card={card} host={host} /> : <FallbackCard c={c} host={host} />, SHARE_CARD_SIZE);
}
