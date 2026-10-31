import { describe, expect, it } from "vitest";
import { ACCOUNTS_UNAVAILABLE_COPY, LOGIN_PATH, accountsUnavailable, canViewPrivate } from "@/lib/authUi";

describe("accountsUnavailable", () => {
  it("is true only with no database and no demo mode", () => {
    expect(accountsUnavailable({ database: false, demoMode: false })).toBe(true);
    expect(accountsUnavailable({ database: true, demoMode: false })).toBe(false);
    expect(accountsUnavailable({ database: false, demoMode: true })).toBe(false);
  });
  it("stays enabled until capabilities have loaded", () => {
    expect(accountsUnavailable(null)).toBe(false);
  });
  it("uses plain copy with no env var names or em dashes", () => {
    for (const text of Object.values(ACCOUNTS_UNAVAILABLE_COPY)) {
      expect(text).not.toMatch(/DATABASE_URL|DEMO_MODE|—/);
    }
  });
});

describe("sign-out", () => {
  it("sends the user to /login", () => {
    expect(LOGIN_PATH).toBe("/login");
  });
  it("hides private pages, including browser-stored debriefs, once signed out", () => {
    expect(canViewPrivate({ isAuthenticated: false, demoMode: false })).toBe(false);
    expect(canViewPrivate({ isAuthenticated: true, demoMode: false })).toBe(true);
    expect(canViewPrivate({ isAuthenticated: false, demoMode: true })).toBe(true);
  });
});
