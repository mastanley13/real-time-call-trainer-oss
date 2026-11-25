/**
 * AI persona wizard contract shared by the wizard UI and /api/persona/generate.
 * The output is an ordinary Scenario, so a generated persona can be practiced,
 * edited, or exported as a pack file without conversion.
 */
import { z } from "zod";
import { CALL_TYPES, type Scenario } from "./scenarios";

export const CONTEXT_KINDS = ["job", "url", "crm", "icp", "call"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export const CONTEXT_LABELS: Record<ContextKind, string> = {
  job: "Job description",
  url: "Product page",
  crm: "CRM notes",
  icp: "Ideal customer",
  call: "Pasted call",
};

export const WizardInputSchema = z.object({
  role: z.string().min(1).max(40),
  industry: z.string().max(80),
  callType: z.enum(CALL_TYPES),
  difficulty: z.enum(["easy", "medium", "hard"]),
  /** What the rep sells, in their own words. */
  product: z.string().max(400),
  contexts: z
    .array(z.object({ kind: z.enum(CONTEXT_KINDS), text: z.string().max(8000), label: z.string().max(200).optional() }))
    .max(5),
  /**
   * Keep the rep's real company, product, pricing and domain details in the persona (it is saved privately to their
   * account). False anonymizes every real name. Defaults to true, so callers that never send it still parse.
   */
  keepRealNames: z.boolean().default(true),
});
/** What a caller sends: keepRealNames may be left out (it defaults to true when parsed). */
export type WizardInput = z.input<typeof WizardInputSchema>;

/** Where a generated field came from: the context tab and the snippet that produced it. */
export interface FieldSource {
  kind: ContextKind | "chips" | "model";
  snippet: string;
}

export interface WizardOutput {
  scenario: Scenario;
  /** Keyed by field path, e.g. "aiPersona.behavior", "objections.0", "traineeGoal". */
  sources: Record<string, FieldSource>;
  /** "llm" when the configured model drafted it. The model id itself is never sent to the browser. */
  method: "llm" | "template";
}

export interface FetchedPage {
  url: string;
  title: string;
  /** The page's meta, Open Graph or JSON-LD description, when it has one. */
  description?: string;
  /** A category or industry the page states about itself (JSON-LD), when present. */
  suggestedIndustry?: string;
  /** A 1-2 sentence pitch (at most 300 characters) built from the title and description, for the product line. */
  suggestedProduct?: string;
  text: string;
  bytes: number;
}
