/** Brand mark: a handset inside a rounded square. Mirrors src/app/icon.svg. */
export default function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lm-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1D4ED8" />
          <stop offset="1" stopColor="#0F766E" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lm-g)" />
      <path d="M10 13.2c0-1 .7-1.7 1.6-1.7h1.5c.6 0 1.1.4 1.2 1l.3 1.6c.1.5-.1 1-.5 1.3l-.9.7c.8 1.6 2 2.8 3.6 3.6l.7-.9c.3-.4.8-.6 1.3-.5l1.6.3c.6.1 1 .6 1 1.2v1.5c0 .9-.7 1.6-1.7 1.6C14.800 23 10 18.200 10 13.200Z" fill="#fff" />
      <path d="M19 9.500c2 .3 3.500 1.800 3.800 3.800M19.200 12c.9.200 1.500.800 1.700 1.700" stroke="#99F6E4" strokeWidth="1.500" strokeLinecap="round" fill="none" />
    </svg>
  );
}
