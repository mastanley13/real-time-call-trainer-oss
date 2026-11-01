"use client";

import { useEffect, useState } from "react";
import { NOTICE_TEXT, takeNotice, type NoticeKind } from "@/lib/checkoutStart";

/**
 * A one-time plan notice for /trainer ("You're on Free. Pro and Team open soon."). The notice is left in
 * sessionStorage by sign-up or by a checkout that fell back to Free, and cleared the first time this renders.
 * Renders nothing when there is none, so the page layout is untouched.
 */
export default function PlanNotice() {
  const [kind, setKind] = useState<NoticeKind | null>(null);
  useEffect(() => { setKind(takeNotice()); }, []);
  if (!kind) return null;
  return (
    <div className="page pt-4">
      <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-line bg-sunken p-3 text-sm text-ink">
        <p>{NOTICE_TEXT[kind]}</p>
        <button type="button" className="btn-quiet btn-sm" onClick={() => setKind(null)}>Dismiss</button>
      </div>
    </div>
  );
}
