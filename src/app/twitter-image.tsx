import { OG_ALT } from "@/lib/seo";
import { renderShareCard } from "@/lib/shareCard";

export const alt = OG_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Same share card as opengraph-image.tsx. */
export default function Image() {
  return renderShareCard();
}
