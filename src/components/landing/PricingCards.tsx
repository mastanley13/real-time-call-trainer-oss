"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useBilling } from "@/components/landing/BillingContext";
import { OPEN_SOON_LINE, registerHref, type Billing } from "@/lib/pricing";
import { PAID_CTA_BILLING_OFF, PLAN_CTA, PLAN_IDS, planHeads, workbookCaption, workbookRows, type PlanId } from "@/lib/pricingWorkbook";
import { trackPremiumUpsell } from "@/lib/premiumEventTypes";

/**
 * The sign-up link and label for a plan. Free keeps its plain sign-up link. Pro and Team always link to sign-up with the
 * plan and the selected period. With billing off nothing is sold, so the paid label is "Create account" with the
 * open-soon note; a paid button never reads "Start free".
 */
export function tierAction(id: string, cta: string, billingEnabled: boolean, interval: Billing) {
  if (id === "free") return { cta, href: registerHref({ src: "pricing" }), soon: false };
  const plan = id === "pro" ? "pro" : "team";
  const href = registerHref({ plan, interval, src: "pricing" });
  return billingEnabled ? { cta, href, soon: false } : { cta: PAID_CTA_BILLING_OFF, href, soon: true };
}

const OPEN_SOON_ID = "plans-open-soon";
const ctaClass = (id: PlanId) => `${id === "pro" ? "btn-primary" : "btn-ghost"} btn-lg text-center`;
const proFill = (id: PlanId) => (id === "pro" ? " bg-sunken" : "");

/**
 * Comparison workbook: a billing period toggle, then one table (wide screens) or one definition list per plan (narrow
 * screens) from the same data. Pro carries the only emphasis: a subtle column fill on the table and a primary border on
 * its card. `billingEnabled` and `premiumOnSale` come from the server.
 */
export default function PricingCards({ billingEnabled, premiumOnSale = false }: { billingEnabled: boolean; premiumOnSale?: boolean }) {
  const { billing, setBilling } = useBilling();
  useEffect(() => { if (premiumOnSale) trackPremiumUpsell("pricing"); }, [premiumOnSale]);
  const heads = planHeads(billing);
  const rows = workbookRows(billing);
  const actions = Object.fromEntries(PLAN_IDS.map((id) => [id, tierAction(id, PLAN_CTA[id], billingEnabled, billing)])) as Record<PlanId, ReturnType<typeof tierAction>>;
  const described = (id: PlanId) => (actions[id].soon ? OPEN_SOON_ID : undefined);

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="plans-h" className="text-2xl font-bold leading-8">Plans and prices</h2>
        <div role="group" aria-label="Billing period" className="inline-flex flex-wrap gap-1 rounded-control border border-line bg-sunken p-1">
          {(["month", "year"] as const).map((b) => (
            <button key={b} type="button" aria-pressed={billing === b} onClick={() => setBilling(b)}
              className={`min-h-[44px] rounded-control border px-4 text-sm font-semibold ${billing === b ? "border-line bg-surface text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
              {b === "month" ? "Monthly" : "Annual (2 months free)"}
            </button>
          ))}
        </div>
      </div>

      {/* Wide screens: one aligned table. */}
      <div data-layout="table" className="mt-6 hidden rounded-panel border border-line bg-surface lg:block">
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">{workbookCaption(billing)}</caption>
          <colgroup>
            <col className="w-[28%]" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="px-4 pb-4 pt-6 align-bottom text-sm font-semibold text-ink-soft xl:px-6">
                {billing === "month" ? "Monthly plans" : "Annual plans"}
              </th>
              {PLAN_IDS.map((id) => (
                <th key={id} scope="col" className={`px-4 pb-4 pt-6 align-bottom xl:px-6${proFill(id)}`}>
                  <span className="block font-heading text-xl font-bold text-ink">{heads[id].name}</span>
                  <span className="mt-1 block text-sm font-normal text-ink-soft">{heads[id].note}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line">
              <th scope="row" className="px-4 py-4 align-top font-semibold text-ink xl:px-6">Price</th>
              {PLAN_IDS.map((id) => (
                <td key={id} className={`px-4 py-4 align-top xl:px-6${proFill(id)}`}>
                  <span className="block font-heading text-[32px] font-bold leading-10 text-ink">{heads[id].price}</span>
                  <span className="block text-sm text-ink-soft">{heads[id].unit}</span>
                  {heads[id].minimum && <span className="mt-1 block text-sm font-semibold text-ink">{heads[id].minimum}</span>}
                  {heads[id].saving && <span className="mt-1 block font-mono text-xs text-ink-soft">{heads[id].saving}</span>}
                </td>
              ))}
            </tr>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <th scope="row" className="px-4 py-4 align-top font-semibold text-ink xl:px-6">{r.label}</th>
                {PLAN_IDS.map((id) => (
                  <td key={id} className={`px-4 py-4 align-top text-ink xl:px-6${proFill(id)}`}>{r.cells[id]}</td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-line">
              <th scope="row" className="px-4 py-5 align-top font-semibold text-ink xl:px-6">Choose your plan</th>
              {PLAN_IDS.map((id) => (
                <td key={id} className={`px-4 py-5 align-top xl:px-6${proFill(id)}`}>
                  <Link href={actions[id].href} aria-describedby={described(id)} className={ctaClass(id)}>{actions[id].cta}</Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Narrow screens and high zoom: one definition list per plan, Free first. */}
      <div data-layout="lists" className="mt-6 grid gap-4 lg:hidden">
        {PLAN_IDS.map((id) => {
          const h = heads[id];
          return (
            <div key={id} className={`min-w-0 rounded-panel border bg-surface p-5 sm:p-6 ${id === "pro" ? "border-primary" : "border-line"}`}>
              <h3 id={`tier-${id}`} className="text-2xl font-bold leading-8">{h.name}</h3>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
                <span className="font-heading text-[32px] font-bold leading-10 text-ink">{h.price}</span>
                <span className="text-sm text-ink-soft">{h.unit}</span>
              </p>
              {h.minimum && <p className="mt-1 text-sm font-semibold text-ink">{h.minimum}</p>}
              {h.saving && <p className="mt-1 font-mono text-xs text-ink-soft">{h.saving}</p>}
              <p className="mt-2 text-sm text-ink-soft">{h.note}</p>
              <dl className="mt-5 divide-y divide-line border-y border-line text-sm leading-5">
                {rows.map((r) => (
                  <div key={r.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3">
                    <dt className="text-ink-soft">{r.label}</dt>
                    <dd className="min-w-0 max-w-full break-words text-right font-semibold text-ink">{r.cells[id]}</dd>
                  </div>
                ))}
              </dl>
              <Link href={actions[id].href} aria-describedby={described(id)} className={`${ctaClass(id)} mt-5 w-full`}>{actions[id].cta}</Link>
            </div>
          );
        })}
      </div>

      {!billingEnabled && <p id={OPEN_SOON_ID} className="mt-4 text-sm text-ink-soft">{OPEN_SOON_LINE}</p>}
    </div>
  );
}
