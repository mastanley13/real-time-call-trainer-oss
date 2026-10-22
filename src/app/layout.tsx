import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import SiteHeader from "@/components/SiteHeader";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const sora = Sora({ subsets: ["latin"], display: "swap", variable: "--font-sora" });

export const metadata: Metadata = {
  title: "Real-Time Call Trainer — practice live calls with an AI caller",
  description:
    "Open-source voice practice for sales and service calls. Editable scenarios, ElevenLabs voice agents, and rubric-based grading backed by transcript quotes.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`}>
      <body className="min-h-screen">
        <AuthProvider>
          <a href="#main" className="skip-link">Skip to content</a>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="outline-none">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
