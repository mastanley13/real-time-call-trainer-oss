"use client";

import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { SUPPORT_URL, type CheckoutNotice } from "@/lib/billingUi";

interface Props {
  notice: CheckoutNotice;
  /** Replaces the body when the button's own action failed. */
  failure?: string | null;
  busy: boolean;
  /** Disables the button while any plan or portal call is running. */
  disabled: boolean;
  onAction: () => void;
}

/**
 * The inline banner for a checkout that did not start: bold headline (focused on show), body, one primary button and,
 * for an unavailable plan, a link to report it. One live role per banner. Active is a neutral info style; the others
 * use the caution style, and past_due says so in words.
 */
const BillingNotice = forwardRef<HTMLParagraphElement, Props>(function BillingNotice({ notice, failure, busy, disabled, onAction }, headlineRef) {
  const tone = notice.role === "status" ? "banner-ok" : "banner-warn";
  return (
    <div className={`${tone} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`} role={notice.role}>
      <div className="max-w-[70ch]">
        <p ref={headlineRef} tabIndex={-1} className="font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{notice.headline}</p>
        <p className="mt-1">{failure ?? notice.body}</p>
      </div>
      <div className="flex flex-col gap-2 sm:items-end">
        <button type="button" className="btn-primary min-h-11 w-full sm:w-auto" onClick={onAction} disabled={disabled} aria-busy={busy}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {failure ? "Try again" : notice.button}
        </button>
        {notice.help && (
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">Report a problem on GitHub</a>
        )}
      </div>
    </div>
  );
});

export default BillingNotice;
