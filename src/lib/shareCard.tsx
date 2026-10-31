import { ImageResponse } from "next/og";

export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

/**
 * Share card for Open Graph and Twitter. Brand exception to the token rule: ImageResponse cannot read CSS variables,
 * so it uses the fixed colors of src/app/icon.svg (deck navy and signal cyan), like LogoMark.tsx.
 */
export function renderShareCard() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 96px", background: "#0A0F1A", color: "#F5F7FB" }}>
        <div style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: "#22D3EE" }} />
        <div style={{ display: "flex", marginTop: 40, fontSize: 84, fontWeight: 700, letterSpacing: -2 }}>Real-Time Call Trainer</div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 44, color: "#22D3EE" }}>Practice the call before it costs you the deal</div>
      </div>
    ),
    SHARE_CARD_SIZE,
  );
}
