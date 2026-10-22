import "server-only";

/** Runtime capability flags. Everything is optional; the UI degrades gracefully. */
export function getCapabilities() {
  return {
    demoMode: process.env.DEMO_MODE === "true",
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID),
    llm: Boolean(llmKey()),
    database: Boolean(process.env.DATABASE_URL),
  };
}

export function llmKey(): string | undefined {
  return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

export const DEMO_USER = {
  id: "demo-user",
  email: "demo@example.local",
  firstName: "Demo",
  lastName: "User",
  role: "owner" as const,
};
