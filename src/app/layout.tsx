import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import SiteHeader from "@/components/SiteHeader";
import MobileTabBar from "@/components/MobileTabBar";
import CommandPalette from "@/components/CommandPalette";
import { shareImages, siteUrl } from "@/lib/seo";

/**
 * Stage and Desk sets every word in Radio Canada Big (SIL Open Font License, src/app/fonts/OFL.txt), self-hosted: one
 * 18 KB variable file, weights 400 to 700, so builds never fetch fonts. Its tabular figures swap digits only (see the
 * README there), so clocks and scores line up without wide gaps.
 */
const radio = localFont({ src: [{ path: "./fonts/RadioCanadaBig-latin-wght.woff2", weight: "400 700", style: "normal" }], display: "swap", variable: "--font-radio" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
  description:
    "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
  openGraph: {
    title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
    description:
      "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
    images: shareImages("/").openGraph,
  },
  twitter: {
    card: "summary_large_image",
    title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
    description:
      "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
    images: shareImages("/").twitter,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F4F1" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1014" },
  ],
};

/** Applies the saved theme before first paint so there is no light/dark flash. */
const themeScript = `try{var t=localStorage.getItem("rtct.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={radio.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <AuthProvider>
          <a href="#main" className="skip-link">Skip to content</a>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0">{children}</main>
          <MobileTabBar />
          <CommandPalette />
        </AuthProvider>
      </body>
    </html>
  );
}
