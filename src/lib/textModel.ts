/**
 * Which model runs a text job, from /api/config capabilities. Pure and client-safe. `caps.llm` only says that
 * some role has a key, so availability is decided per role: a role missing from `llmModels` runs its
 * rules-based fallback. An older payload without `llmModels` falls back to the single `llm` and `model` fields.
 */
export type TextRole = "coach" | "grade" | "persona" | "wizard";

export interface TextCaps {
  llm?: boolean;
  model?: string;
  llmModels?: Partial<Record<TextRole, string>>;
}

/** The model the role runs on, or undefined when the role has no key and uses its fallback. */
export function textModelFor(caps: TextCaps | null | undefined, role: TextRole): string | undefined {
  if (!caps) return undefined;
  if (caps.llmModels) return caps.llmModels[role] || undefined;
  return caps.llm ? caps.model || "AI model" : undefined;
}
