"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { NOTICE_TEXT, takeNotice, type NoticeKind } from "@/lib/checkoutStart";

/**
 * A one-time plan notice for /trainer ("You're on Free. Pro and Team checkout is not set up on this server."). The notice is left in
 * sessionStorage by sign-up or by a checkout that fell back to Free, and cleared the first time this renders.
 * Renders nothing when there is none, so the page layout is untouched.
 */
export default function PlanNotice() {
  const [kind, setKind] = useState<NoticeKind | null>(null);
  useEffect(() => { setKind(takeNotice()); }, []);
  if (!kind) return null;
  return (
    // Its own compact gutter, not a second .page: the trainer below already brings the page padding.
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div role="status" className="banner-info flex items-center justify-between gap-3">
        <p className="flex items-center gap-2"><Info size={16} strokeWidth={1.75} className="shrink-0 text-primary" aria-hidden />{NOTICE_TEXT[kind]}</p>
        <button type="button" className="btn-quiet btn-sm shrink-0" onClick={() => setKind(null)}>Dismiss</button>
      </div>
    </div>
  );
}
