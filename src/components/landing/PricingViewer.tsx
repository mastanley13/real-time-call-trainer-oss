"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useOptionalAuth } from "@/contexts/AuthContext";
import { pricingViewerFromUsage, type PricingViewer } from "@/lib/pricing";

/**
 * Who is looking at /pricing: null when signed out (and while the session is still being read), so anonymous visitors
 * get the sign-up buttons unchanged. Outside a provider it is also null, so a pricing component rendered on its own
 * behaves as signed out.
 */
export const PricingViewerContext = createContext<PricingViewer | null>(null);

/**
 * Reads the session the way the app does (AuthContext) and, when signed in, the plan from /api/usage, the same answer the
 * billing page reads. One request for the whole page. Until it arrives, or when it fails or minutes are not metered, the
 * plan is unknown (plan: null).
 */
export function PricingViewerProvider({ children }: { children: React.ReactNode }) {
  const auth = useOptionalAuth();
  const signedIn = !!auth?.isAuthenticated;
  const [viewer, setViewer] = useState<PricingViewer>({ plan: null });
  useEffect(() => {
    if (!signedIn) { setViewer({ plan: null }); return; }
    let live = true;
    fetch("/api/usage", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setViewer(pricingViewerFromUsage(d)); })
      .catch(() => { if (live) setViewer({ plan: null }); });
    return () => { live = false; };
  }, [signedIn]);
  return <PricingViewerContext.Provider value={signedIn ? viewer : null}>{children}</PricingViewerContext.Provider>;
}

export const usePricingViewer = () => useContext(PricingViewerContext);
