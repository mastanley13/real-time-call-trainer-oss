"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/Skeleton";
import SeatsField from "@/components/settings/SeatsField";
import { SUPPORT_URL, seatsOnBlur } from "@/lib/billingUi";
import { billingNoticeHref, intentFromQuery, rememberNotice, startCheckout } from "@/lib/checkoutStart";
import { PREMIUM_CALL_LENGTH_NOTE, premiumDisclosure, premiumPriceLine, registerHref } from "@/lib/pricing";
import { trackPremiumUpsell } from "@/lib/premiumEventTypes";
import { TEAM_MIN_SEATS } from "@/lib/usagePlan";

/**
 * Shown when /api/config could not be read. Focus moves to the heading on load so a screen reader hears what happened.
 * Try again reloads the page, so the button shows a pending state meanwhile, and focus moves to the heading first
 * because a disabled button would otherwise drop it to the page body.
 */
export function ConfigFailed() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const retry = () => {
    if (retrying) return;
    headingRef.current?.focus();
    setRetrying(true);
    window.location.reload();
  };
  return (
    <div className="page enter min-w-0 max-w-xl space-y-4 py-10">
      <p className="eyebrow">Checkout</p>
      <h1 ref={headingRef} tabIndex={-1} className="break-words text-3xl font-bold focus:outline-none">Checkout could not load right now</h1>
      <p className="break-words text-ink-soft">We could not reach the server to check your plan options. Nothing was charged. Please try again.</p>
      <button type="button" className="btn-primary max-w-full" disabled={retrying} aria-busy={retrying} onClick={retry}>
        {retrying && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
        {retrying ? "Trying again..." : "Try again"}
      </button>
      <p className="text-sm text-ink-muted"><Link href="/pricing" className="underline underline-offset-2 hover:text-ink">Back to pricing</Link></p>
    </div>
  );
}

/** Checkout-shaped placeholder: step strip, heading, one panel. */
export function CheckoutSkeleton() {
  return (
    <div className="page max-w-xl space-y-5 py-10" role="status">
      <Skeleton className="h-3 w-20" />
      <div className="grid grid-cols-3 gap-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-36" />
      <span className="sr-only">Loading...</span>
    </div>
  );
}

type StepState = "done" | "current" | "next";
const STEP_LAMP = { done: "lamp-ok", current: "lamp-signal", next: "lamp-off" } as const;
const STEP_BAR = { done: "bg-ok", current: "bg-primary", next: "bg-line" } as const;
const STEP_SR = { done: ", done", current: ", current step", next: ", next" } as const;

/** Plan, Seats, Payment on Stripe. Done steps show an ok lamp, the current one a signal lamp, later ones an off lamp. */
function FlightPlan({ current, name, period }: { current: 1 | 2; name: string; period: string }) {
  const steps = [
    { label: "Plan", detail: `${name}, ${period}` },
    { label: "Seats", detail: name === "Team" ? `${TEAM_MIN_SEATS} or more` : "Just you" },
    { label: "Payment on Stripe", detail: "Card and receipt" },
  ];
  return (
    <ol aria-label="Checkout steps" className="grid grid-cols-3 gap-2 sm:gap-3">
      {steps.map((s, i) => {
        const st: StepState = i < current ? "done" : i === current ? "current" : "next";
        return (
          <li key={s.label} aria-current={st === "current" ? "step" : undefined} className="min-w-0">
            <span className={`block h-0.5 rounded-full ${STEP_BAR[st]}`} aria-hidden />
            <span className="mt-2 flex items-center gap-2">
              <span className={`lamp ${STEP_LAMP[st]}`} aria-hidden />
              <span className={`truncate text-xs font-semibold ${st === "next" ? "text-ink-muted" : "text-ink"}`}>{s.label}</span>
            </span>
            <span className="mt-0.5 block truncate pl-4 font-mono text-[11px] text-ink-muted">
              {s.detail}
              <span className="sr-only">{STEP_SR[st]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The form footer. The button keeps focus while busy (aria-disabled); `go` ignores a second press. */
function CheckoutFooter({ busy }: { busy: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-xs text-ink-muted">Next: payment on Stripe.</p>
      <button type="submit" className="btn-primary" aria-disabled={busy || undefined}>
        {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
        Continue to checkout
      </button>
    </div>
  );
}

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
  /** Premium voice is on sale on this server (PREMIUM_VOICE_ON_SALE). */
  const premiumOnSale = !!capabilities?.premiumOnSale;
  /**
   * Spec 10.2: the box is never offered before the organization's first graded call. The server decides from stored
   * graded sessions and sends one allowlisted boolean (/api/usage premiumVoice.offerReady); the checkout route checks
   * it again for premium:true. null while asking; false on any failure (fail closed: the plan alone is still sold).
   */
  const [offerReady, setOfferReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!premiumOnSale || !isAuthenticated) return;
    let live = true;
    fetch("/api/usage", { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { premiumVoice?: { offerReady?: unknown } } | null) => { if (live) setOfferReady(d?.premiumVoice?.offerReady === true); })
      .catch(() => { if (live) setOfferReady(false); });
    return () => { live = false; };
  }, [premiumOnSale, isAuthenticated]);
  /** New-buyer Premium voice box: on sale AND offer ready. Otherwise Pro starts checkout at once, as off sale. */
  const premiumOffer = premiumOnSale && offerReady === true;
  const waitingForOffer = premiumOnSale && offerReady === null;
  const [addPremium, setAddPremium] = useState(false);
  useEffect(() => { if (premiumOffer && isAuthenticated && plan) trackPremiumUpsell("checkout"); }, [premiumOffer, isAuthenticated, plan]);

  const go = useCallback(async (seats?: number) => {
    if (!plan || started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setRestored(false);
    const out = await startCheckout({ plan, interval, seats, premium: premiumOffer && addPremium });
    if (out.kind === "redirect") {
      window.location.assign(out.url);
      return;
    }
    if (out.kind === "already_subscribed") return router.replace(billingNoticeHref(out.status));
    if (out.kind === "unavailable") {
      rememberNotice("paid_soon");
      return router.replace("/trainer");
    }
    started.current = false;
    setBusy(false);
    setError({ message: out.message, help: out.help });
  }, [plan, interval, router, premiumOffer, addPremium]);

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
    // Pro starts at once, unless the Premium box is offered: then the page first shows it and a Continue button.
    if (waitingForOffer) return;
    if (plan === "pro" && !premiumOffer) void go();
  }, [capabilities, capabilitiesFailed, isLoading, isAuthenticated, plan, interval, router, go, premiumOffer, waitingForOffer]);

  if (isLoading || !isAuthenticated || !plan || (!capabilities && !capabilitiesFailed)) return <CheckoutSkeleton />;

  if (!capabilities) return <ConfigFailed />;

  const name = plan === "pro" ? "Pro" : "Team";
  const period = interval === "year" ? "Annual" : "Monthly";
  const premiumBox = premiumOffer && (
    <div className="w-full rounded-lg border border-line bg-sunken/60 px-3 pb-3 text-sm">
      <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
        <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--primary))]" checked={addPremium} onChange={(e) => setAddPremium(e.target.checked)} disabled={busy} aria-describedby="premium-checkout-help" />
        <span className="font-semibold text-ink">Add Premium voice</span>
      </label>
      <div id="premium-checkout-help" className="space-y-1 pl-7 text-xs leading-relaxed text-ink-muted">
        <p>{premiumPriceLine(plan, interval)}</p>
        <p>{premiumDisclosure(plan)}</p>
        <p>{PREMIUM_CALL_LENGTH_NOTE}</p>
      </div>
    </div>
  );
  return (
    <div className="page enter max-w-xl space-y-5 py-10">
      <p className="eyebrow">Checkout</p>
      <FlightPlan current={plan === "team" ? 1 : 2} name={name} period={period} />
      <h1 className="text-3xl font-bold">{plan === "team" ? "Choose your seats" : premiumOffer ? `Check out ${name}` : `Opening checkout for ${name}`}</h1>
      <p className="text-ink-soft">
        {plan === "team"
          ? `Team is billed ${interval === "year" ? "yearly" : "monthly"} per seat, with a ${TEAM_MIN_SEATS}-seat minimum. You will pay on Stripe.`
          : `${name} is billed ${interval === "year" ? "yearly" : "monthly"}. You will pay on Stripe.`}
      </p>
      {error && (
        <div role="alert" className="banner-alert">
          <p>{error.message}</p>
          {error.help && <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">Report a problem on GitHub</a>}
        </div>
      )}
      {plan === "team" ? (
        <form
          className="panel space-y-4 p-4 sm:p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            const left = seatsOnBlur(seatsText);
            setSeatsText(left.value);
            setSeatsNote(left.note);
            void go(Number(left.value));
          }}
        >
          <SeatsField value={seatsText} note={seatsNote} disabled={busy}
            onChange={(text) => { setSeatsText(text); setSeatsNote(null); }}
            onBlur={() => { const left = seatsOnBlur(seatsText); setSeatsText(left.value); setSeatsNote(left.note); }} />
          {premiumBox}
          {/* The button gets its own footer row: the seats help line under the box would pull a side-by-side button off the input. */}
          <CheckoutFooter busy={busy} />
        </form>
      ) : premiumOffer ? (
        <form className="panel space-y-4 p-4 sm:p-5" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          {premiumBox}
          <CheckoutFooter busy={busy} />
        </form>
      ) : (
        <div role="status" className={busy ? "panel flex items-center gap-3 px-4 py-3 text-sm text-ink-soft" : "sr-only"}>
          {busy && <><span className="lamp lamp-signal motion-safe:animate-lamp-pulse" aria-hidden />One moment.</>}
        </div>
      )}
      {(error || restored) && plan === "pro" && !premiumOffer && !busy && <button type="button" className="btn-primary" onClick={() => void go()}>Try again</button>}
      <p className="text-sm text-ink-muted"><Link href="/pricing" className="underline underline-offset-2 hover:text-ink">Back to pricing</Link></p>
    </div>
  );
}
