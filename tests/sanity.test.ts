import { afterEach, describe, expect, it, vi } from "vitest";
import { LIBRARY } from "@/lib/personas";
import { talkTrackSteps } from "@/lib/scenarios";
import { llmKey } from "@/lib/serverConfig";

describe("test harness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the persona library through the @ alias", () => {
    expect(LIBRARY.length).toBeGreaterThan(50);
    expect(talkTrackSteps("1. a\n2. b")).toEqual(["a", "b"]);
  });

  it("loads server-only modules and reads keys at call time", () => {
    // Other suites rely on this to force the no-key paths.
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(llmKey()).toBeUndefined();
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    expect(llmKey()).toBe("sk-test-not-real");
  });
});
