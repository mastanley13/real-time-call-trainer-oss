/**
 * Pure, client-safe helpers for the 1-URL Persona Wizard quick-start path.
 * Normalizes a pasted website URL, infers a fitting sales job family and call type
 * from the fetched page when the rep did not pick them manually, and builds a valid
 * WizardInput ready for /api/persona/generate.
 */
import type { CallType } from "./scenarios";
import type { FetchedPage, WizardInput } from "./wizard-types";

/** Adds https:// when the user pastes a bare domain like acme.com/pricing. */
export function normalizeWizardUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const ROLE_RULES: { role: string; pattern: RegExp }[] = [
  { role: "collections", pattern: /\b(debt collection|collections agency|past[- ]due recovery|accounts receivable recovery)\b/i },
  { role: "mortgage", pattern: /\b(mortgage|home loan|refinanc(?:e|ing)|heloc|fha loan|va loan|loan officer|lending)\b/i },
  { role: "insurance", pattern: /\b(insurance|policyholder|underwriting|auto coverage|homeowners policy|life policy|insurance broker|insurance agency)\b/i },
  { role: "solar", pattern: /\b(solar panels?|rooftop solar|solar installation|solar energy|battery storage|photovoltaic)\b/i },
  { role: "auto", pattern: /\b(dealership|auto group|car sales|pre-owned vehicles?|used cars?|new inventory|test drive|certified pre-owned)\b/i },
  { role: "home-services", pattern: /\b(hvac|plumbing|plumber|roofing|roofer|water heater|air conditioning|furnace|electrical service|pest control|remodeling|siding|gutter)\b/i },
  { role: "real-estate", pattern: /\b(real estate|realtor|homes for sale|property listing|buyer agent|listing agent|commercial real estate|mls)\b/i },
  { role: "medical", pattern: /\b(medical device|medtech|surgical|clinical trial|patient monitoring|diagnostic equipment|hospital system|biotech)\b/i },
  { role: "financial", pattern: /\b(wealth management|financial advisor|fiduciary|retirement planning|portfolio management|investment advisory|ria)\b/i },
  { role: "recruiting", pattern: /\b(recruiting|staffing agency|talent acquisition|executive search|headhunt|placement agency)\b/i },
  { role: "logistics", pattern: /\b(freight|3pl|trucking|carrier network|supply chain|fleet management|shipping logistics|load board|brokerage)\b/i },
  { role: "telecom", pattern: /\b(fiber internet|broadband|business phone|voip|wireless carrier|telecom|utility provider)\b/i },
  { role: "retail", pattern: /\b(online store|showroom|retail store|consumer goods|direct-to-consumer|add to cart|shop now)\b/i },
];

const INBOUND_DEFAULT_ROLES = new Set(["home-services", "auto", "real-estate", "retail"]);

/** Infers the closest JOB_FAMILIES id from a fetched page, defaulting to "sdr". */
export function inferRoleFromPage(
  page: Pick<FetchedPage, "title" | "description" | "suggestedIndustry" | "suggestedProduct" | "text">,
): string {
  const haystack = [
    page.suggestedIndustry ?? "",
    page.title,
    page.description ?? "",
    page.suggestedProduct ?? "",
    page.text.slice(0, 1200),
  ].join("\n");

  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(haystack)) return rule.role;
  }
  return "sdr";
}

/** Picks a natural default call type for an auto-inferred job family. */
export function inferCallTypeForRole(role: string, fallback: CallType = "cold"): CallType {
  if (role === "collections") return "collections";
  if (INBOUND_DEFAULT_ROLES.has(role)) return "inbound";
  return fallback;
}

/** Formats fetched page content for the wizard's Product page context tab. */
export function formatFetchedPageContext(page: Pick<FetchedPage, "title" | "text">): string {
  const combined = page.title ? `${page.title}\n\n${page.text}` : page.text;
  return combined.slice(0, 8000);
}

/**
 * Builds a complete, schema-bounded WizardInput from a fetched page plus any
 * fields or extra context tabs the rep already customized.
 */
export function buildQuickStartInput(
  page: FetchedPage,
  current: WizardInput,
  opts?: {
    rolePicked?: boolean;
    callTypePicked?: boolean;
    extraContexts?: WizardInput["contexts"];
  },
): WizardInput {
  const role = opts?.rolePicked ? current.role : inferRoleFromPage(page);
  const callType = opts?.callTypePicked ? current.callType : inferCallTypeForRole(role, current.callType);
  const industry = (current.industry.trim() || page.suggestedIndustry || "").slice(0, 80);
  const product = (
    current.product.trim() ||
    page.suggestedProduct ||
    page.description ||
    page.title ||
    page.url
  ).slice(0, 400);

  const urlContext = {
    kind: "url" as const,
    text: formatFetchedPageContext(page),
    label: page.url.slice(0, 200),
  };

  const extras = (opts?.extraContexts ?? current.contexts)
    .filter((c) => c.kind !== "url" && c.text.trim().length > 0)
    .slice(0, 4)
    .map((c) => ({
      kind: c.kind,
      text: c.text.slice(0, 8000),
      ...(c.label ? { label: c.label.slice(0, 200) } : {}),
    }));

  return {
    role: role.slice(0, 40),
    industry,
    callType,
    difficulty: current.difficulty,
    product,
    keepRealNames: current.keepRealNames ?? true,
    contexts: [urlContext, ...extras],
  };
}
