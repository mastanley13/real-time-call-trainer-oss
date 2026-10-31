import { describe, expect, it } from "vitest";
import {
  BASELINE_LINE,
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  WELCOME_KEY,
  dismissFocusTarget,
  markOnboardingSeen,
  readOnboarding,
  setWelcome,
  takeWelcome,
  welcomeCopy,
  type KeyValueStore,
} from "@/lib/onboarding";

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: KeyValueStore = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};

describe("onboarding storage", () => {
  it("is open until dismissed, then stays dismissed", () => {
    const s = memory();
    expect(readOnboarding(s)).toBe("open");
    expect(markOnboardingSeen(s)).toBe(true);
    expect(s.data.get(ONBOARDING_KEY)).toBe("dismissed");
    expect(readOnboarding(s)).toBe("dismissed");
  });

  it("ignores other values", () => {
    const s = memory();
    s.setItem(ONBOARDING_KEY, "maybe");
    expect(readOnboarding(s)).toBe("open");
  });

  it("does not throw when storage does", () => {
    expect(readOnboarding(throwing)).toBe("unavailable");
    expect(markOnboardingSeen(throwing)).toBe(false);
    expect(() => setWelcome(throwing, "create")).not.toThrow();
    expect(takeWelcome(throwing)).toBeNull();
    expect(readOnboarding(null)).toBe("unavailable");
    expect(markOnboardingSeen(null)).toBe(false);
    expect(takeWelcome(null)).toBeNull();
  });

  it("reads the welcome flag once and clears it", () => {
    const s = memory();
    setWelcome(s, "join");
    expect(takeWelcome(s)).toBe("join");
    expect(s.data.has(WELCOME_KEY)).toBe(false);
    expect(takeWelcome(s)).toBeNull();
  });

  it("rejects an unknown welcome mode but still clears it", () => {
    const s = memory();
    s.setItem(WELCOME_KEY, "bogus");
    expect(takeWelcome(s)).toBeNull();
    expect(s.data.has(WELCOME_KEY)).toBe(false);
  });
});

describe("welcomeCopy", () => {
  it("names the new team", () => {
    expect(welcomeCopy("Sam", "Acme Test", "create")).toBe("Welcome, Sam. Your team Acme Test is ready.");
  });
  it("names the joined team", () => {
    expect(welcomeCopy("Sam", "Acme Test", "join")).toBe("Welcome, Sam. You joined Acme Test.");
  });
  it("drops the team line without a signup flag or a team", () => {
    expect(welcomeCopy("Sam", "Acme Test", null)).toBe("Welcome, Sam.");
    expect(welcomeCopy("Demo", undefined, "create")).toBe("Welcome, Demo.");
  });
  it("handles a missing first name", () => {
    expect(welcomeCopy(undefined, undefined, null)).toBe("Welcome.");
    expect(welcomeCopy("  ", "Acme Test", "create")).toBe("Welcome. Your team Acme Test is ready.");
  });
});

describe("dismissFocusTarget", () => {
  it("focuses Start when it is enabled", () => {
    expect(dismissFocusTarget({ startDisabled: false, hasModeToggle: true })).toBe("start");
  });
  it("falls back to the mode toggle when Start is disabled (voice unavailable), for Got it and Escape alike", () => {
    expect(dismissFocusTarget({ startDisabled: true, hasModeToggle: true })).toBe("mode");
  });
  it("falls back to the heading when nothing else can take focus", () => {
    expect(dismissFocusTarget({ startDisabled: true, hasModeToggle: false })).toBe("heading");
  });
});

describe("onboarding content", () => {
  it("has exactly the three steps in order", () => {
    expect(ONBOARDING_STEPS.map((s) => s.title)).toEqual(["Pick a scenario", "Have the call", "Read your debrief"]);
    expect(BASELINE_LINE).toBe("Your first grade is a baseline.");
  });
});
