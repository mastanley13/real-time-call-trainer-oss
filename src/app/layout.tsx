import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Sora } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import SiteHeader from "@/components/SiteHeader";
import MobileTabBar from "@/components/MobileTabBar";
import CommandPalette from "@/components/CommandPalette";
import { shareImages, siteUrl } from "@/lib/seo";
import { BRAND_CSS, HOME_TITLE, META_DESCRIPTION, featureAllowed, tenantIcons } from "@/lib/tenant";

/**
 * The tenant icon and favicon (copied to /tenant/ by the prebuild). Unset for the default tenant, so Next serves
 * src/app/icon.svg through the App Router icon convention with its content-hashed URL, as before tenants.
 */
const ICONS = tenantIcons();

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const sora = Sora({ subsets: ["latin"], display: "swap", variable: "--font-sora" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: HOME_TITLE,
  description: META_DESCRIPTION,
  ...(ICONS ? { icons: ICONS } : {}),
  openGraph: {
    title: HOME_TITLE,
    description: META_DESCRIPTION,
    images: shareImages("/").openGraph,
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: META_DESCRIPTION,
    images: shareImages("/").twitter,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F7FB" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0F1A" },
  ],
};

/** Applies the saved theme before first paint so there is no light/dark flash. */
const themeScript = `try{var t=localStorage.getItem("rtct.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Tenant primary color tokens, generated from validated #rrggbb values. Empty for the default tenant. */}
        {BRAND_CSS && <style dangerouslySetInnerHTML={{ __html: BRAND_CSS }} />}
      </head>
      <body className="min-h-screen">
        <AuthProvider>
          <a href="#main" className="skip-link">Skip to content</a>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0">{children}</main>
          <MobileTabBar />
          {featureAllowed("commandPalette") && <CommandPalette />}
        </AuthProvider>
      </body>
    </html>
  );
}
