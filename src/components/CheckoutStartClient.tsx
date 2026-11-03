"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageSkeleton } from "@/components/ui/Skeleton";
import SeatsField from "@/components/settings/SeatsField";
import { SUPPORT_URL, seatsOnBlur } from "@/lib/billingUi";
import { BILLING_NOTICE_PATH, intentFromQuery, rememberNotice, startCheckout } from "@/lib/checkoutStart";
import { registerHref } from "@/lib/pricing";
import { TEAM_MIN_SEATS } from "@/lib/usagePlan";

/**
 * The step between a pricing button and Stripe Checkout (billing on). Signed out goes to register with the same plan and
 * period. Pro starts at once. Team asks for seats first (3 or more). A server that cannot sell the plan falls back to
 * Free with a notice, and an existing plan goes to billing settings.
 */
export default function CheckoutStartClient() {
  const { isAuthenticated, isLoading, capabilities, capabilitiesFailed } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { plan, interval = "month" } = intentFromQuery(params);
  const [seatsText, setSeatsText] = useState(String(TEAM_MIN_SEATS));
  const [seatsNote, setSeatsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; help: boolean } | null>(null);
  // State updates are not instant, so two fast clicks could both pass a check on `busy`. The ref closes that gap.
  const started = useRef(false);

  const go = useCallback(async (seats?: number) => {
    if (!plan || started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setRestored(false);
    const out = await startCheckout({ plan, interval, seats });
    if (out.kind === "redirect") {
      window.location.assign(out.url);
      return;
    }
    if (out.kind === "already_subscribed") return router.replace(BILLING_NOTICE_PATH);
    if (out.kind === "unavailable") {
      rememberNotice("paid_soon");
      return router.replace("/trainer");
    }
    started.current = false;
    setBusy(false);
    setError({ message: out.message, help: out.help });
  }, [plan, interval, router]);

  /** Set when the browser Back button restored this page from the back-forward cache after the Stripe redirect. */
  const [restored, setRestored] = useState(false);
  // Coming back from Stripe with Back restores this page as it was, busy and all. Free the button and offer a retry.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      started.current = false;
      setBusy(false);
      setRestored(true);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // A link with no valid plan has nothing to buy: show the plans.
  useEffect(() => { if (!plan) router.replace("/pricing"); }, [plan, router]);

  useEffect(() => {
    if (isLoading || !plan || (!capabilities && !capabilitiesFailed)) return;
    if (!isAuthenticated) return router.replace(registerHref({ plan, interval, src: "checkout" }));
    // Capabilities unknown (the config request failed): never start checkout, the page offers a retry instead.
    if (!capabilities) return;
    if (!capabilities.billing) {
      rememberNotice("paid_soon");
      return router.replace("/trainer");
    }
    if (plan === "pro") void go();
  }, [capabilities, capabilitiesFailed, isLoading, isAuthenticated, plan, interval, router, go]);

  if (isLoading || !isAuthenticated || !plan || (!capabilities && !capabilitiesFailed)) return <PageSkeleton rows={2} />;

  if (!capabilities) {
    return (
      <div className="page enter max-w-xl space-y-4 py-10">
        <p className="eyebrow">Checkout</p>
        <h1 className="text-3xl font-bold">Checkout could not load right now</h1>
        <p className="text-ink-soft">We could not reach the server to check your plan options. Nothing was charged. Please try again.</p>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>Try again</button>
        <p className="text-sm text-ink-muted"><Link href="/pricing" className="underline underline-offset-2 hover:text-ink">Back to pricing</Link></p>
      </div>
    );
  }

  const name = plan === "pro" ? "Pro" : "Team";
  return (
    <div className="page enter max-w-xl space-y-4 py-10">
      <p className="eyebrow">Checkout</p>
      <h1 className="text-3xl font-bold">{plan === "team" ? "Choose your seats" : `Opening checkout for ${name}`}</h1>
      <p className="text-ink-soft">
        {plan === "team"
          ? `Team is billed ${interval === "year" ? "yearly" : "monthly"} per seat, with a ${TEAM_MIN_SEATS}-seat minimum. You will pay on Stripe.`
          : `${name} is billed ${interval === "year" ? "yearly" : "monthly"}. You will pay on Stripe.`}
      </p>
      {error && (
        <div role="alert" className="banner-warn">
          <p>{error.message}</p>
          {error.help && <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">Report a problem on GitHub</a>}
        </div>
      )}
      {plan === "team" ? (
        <form
          className="flex flex-wrap items-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const left = seatsOnBlur(seatsText);
            setSeatsText(left.value);
            setSeatsNote(left.note);
            void go(Number(left.value));
          }}
        >
          <SeatsField value={seatsText} note={seatsNote} disabled={busy}
            onChange={(text) => { setSeatsText(text); setSeatsNote(null); }}
            onBlur={() => { const left = seatsOnBlur(seatsText); setSeatsText(left.value); setSeatsNote(left.note); }} />
          <button type="submit" className="btn-primary mt-6" disabled={busy}>
            {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
            Continue to checkout
          </button>
        </form>
      ) : (
        busy && <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />One moment.</p>
      )}
      {(error || restored) && plan === "pro" && !busy && <button type="button" className="btn-primary" onClick={() => void go()}>Try again</button>}
      <p className="text-sm text-ink-muted"><Link href="/pricing" className="underline underline-offset-2 hover:text-ink">Back to pricing</Link></p>
    </div>
  );
}
