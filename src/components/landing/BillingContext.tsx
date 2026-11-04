"use client";

import { createContext, useContext, useState } from "react";
import type { Billing } from "@/lib/pricing";

interface BillingState {
  billing: Billing;
  setBilling: (b: Billing) => void;
}

// Without a provider (a card rendered alone) the period stays monthly.
const BillingContext = createContext<BillingState>({ billing: "month", setBilling: () => {} });

/** Shares the Monthly or Annual choice between the plan cards and the compare table. */
export function BillingProvider({ children }: { children: React.ReactNode }) {
  const [billing, setBilling] = useState<Billing>("month");
  return <BillingContext.Provider value={{ billing, setBilling }}>{children}</BillingContext.Provider>;
}

export const useBilling = () => useContext(BillingContext);
