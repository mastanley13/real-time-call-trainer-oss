/**
 * AI persona wizard contract shared by the wizard UI and /api/persona/generate.
 * The output is an ordinary Scenario, so a generated persona can be practised,
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
});
export type WizardInput = z.infer<typeof WizardInputSchema>;

/** Where a generated field came from: the context tab and the snippet that produced it. */
export interface FieldSource {
  kind: ContextKind | "chips" | "model";
  snippet: string;
}

export interface WizardOutput {
  scenario: Scenario;
  /** Keyed by field path, e.g. "aiPersona.behavior", "objections.0", "traineeGoal". */
  sources: Record<string, FieldSource>;
  method: "llm" | "template";
  model?: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  bytes: number;
}
