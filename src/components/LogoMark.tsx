/**
 * Brand mark: a call waveform inside an instrument bezel. Mirrors src/app/icon.svg.
 * Brand exception to the token rule: the mark keeps the favicon's fixed colors in every theme
 * (deck background, line, signal and ok as they are in the dark scope), so it never differs from the tab icon.
 * Change them together with icon.svg.
 */
export default function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0A0F1A" />
      <rect x="1" y="1" width="30" height="30" rx="7" fill="none" stroke="#24314D" />
      <path d="M6 16h3l2-5 3 10 3-13 3 11 2-3h4" fill="none" stroke="#22D3EE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="26" cy="7" r="2" fill="#34D399" />
    </svg>
  );
}
