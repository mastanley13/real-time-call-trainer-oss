import { notFound } from "next/navigation";
import { featureAllowed } from "@/lib/tenant";

/** The team view can be turned off per tenant (features.teamView). The team API routes stay org-scoped either way. */
export default function TeamLayout({ children }: { children: React.ReactNode }) {
  if (!featureAllowed("teamView")) notFound();
  return children;
}
