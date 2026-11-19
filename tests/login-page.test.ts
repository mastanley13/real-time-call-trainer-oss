import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorText,
  CHALLENGE_EXPIRED,
  CODE_USED_ERROR,
  CODE_USED_MESSAGE,
  shouldRestartLogin,
} from "@/lib/authCopy";

const mocks = vi.hoisted(() => ({
  challenge: null as string | null,
  login: vi.fn(),
  completeMfaChallenge: vi.fn(),
  capabilities: { database: true, demoMode: false } as Record<string, unknown>,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    login: mocks.login,
    completeMfaChallenge: mocks.completeMfaChallenge,
    isAuthenticated: false,
    capabilities: mocks.capabilities,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/GoogleButton", async () => {
  const { createElement: el } = await import("react");
  return {
    default: () => el("div", { "data-testid": "google-button" }, "Continue with Google"),
    GOOGLE_ERRORS: { google_failed: "Google sign-in didn't work." },
  };
});
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (init === null) return [mocks.challenge, vi.fn()] as const;
      return actual.useState(init);
    },
  };
});

import LoginPage from "@/app/login/page";

const src = () => readFileSync(join(process.cwd(), "src/app/login/page.tsx"), "utf8");
const html = () => renderToStaticMarkup(createElement(LoginPage));

beforeEach(() => {
  mocks.challenge = null;
  mocks.login.mockReset();
  mocks.completeMfaChallenge.mockReset();
  mocks.capabilities = { database: true, demoMode: false };
});

describe("MFA error copy helpers", () => {
  it("prefers message over error so pages never show code_used", () => {
    expect(apiErrorText({ error: CODE_USED_ERROR, message: CODE_USED_MESSAGE }, "Invalid code")).toBe(CODE_USED_MESSAGE);
    expect(apiErrorText({ error: CHALLENGE_EXPIRED }, "fallback")).toBe(CHALLENGE_EXPIRED);
    expect(apiErrorText({ error: "Invalid code" }, "fallback")).toBe("Invalid code");
    expect(apiErrorText({}, "Sign-in failed")).toBe("Sign-in failed");
  });

  it("restarts login only for sign-in-again responses, not Invalid code or code_used", () => {
    expect(shouldRestartLogin(CHALLENGE_EXPIRED)).toBe(true);
    expect(shouldRestartLogin("Google sign-in could not be completed. Sign in again.")).toBe(true);
    expect(shouldRestartLogin("Invalid code")).toBe(false);
    expect(shouldRestartLogin(CODE_USED_MESSAGE)).toBe(false);
    expect(shouldRestartLogin(CODE_USED_ERROR)).toBe(false);
  });
});

describe("login page MFA step", () => {
  it("shows email, password and the Google button before a challenge", () => {
    const h = html();
    expect(h).toContain("Continue with Google");
    expect(h).toContain("Sign in");
    expect(h).not.toContain("Start over");
    expect(h).not.toContain("Authenticator code");
  });

  it("shows Verify and Start over on the code form, without the Google button", () => {
    mocks.challenge = "challenge-token";
    const h = html();
    expect(h).toContain("Authenticator code");
    expect(h).toContain("Verify");
    expect(h).toContain("Start over");
    expect(h).not.toContain("Continue with Google");
    expect(h).not.toContain(">Sign in<");
  });

  it("clears the challenge on a sign-in-again response, including the Google link 409", () => {
    const page = src();
    expect(page).toContain("shouldRestartLogin(text)");
    expect(page).toContain("setChallenge(null)");
    expect(page).toContain("Start over");
    expect(page).toContain("{!challenge && <GoogleButton />}");
    expect(page.indexOf("Start over")).toBeGreaterThan(page.indexOf("Verify"));
    expect(readFileSync(join(process.cwd(), "src/contexts/AuthContext.tsx"), "utf8")).toContain("apiErrorText(err");
    expect(readFileSync(join(process.cwd(), "src/app/settings/security/page.tsx"), "utf8")).toContain("apiErrorText(");
  });
});
