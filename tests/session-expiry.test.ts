import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expiredLoginHref,
  installSessionExpiryGuard,
  isSessionExpiryBody,
  isSessionGuardedUrl,
  resetSessionExpiryRedirect,
  responseIsSessionExpiry,
  type SessionGuardTarget,
} from "@/lib/sessionExpiry";

const ORIGIN = "https://trainer.example.test";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const EXPIRED = { error: "Invalid or expired session" };
const MISSING = { error: "Authentication required" };

/** Lets the background clone read and the redirect decision finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A window-like target with an in-memory localStorage stand-in. */
function setup(opts: { path?: string; search?: string; demo?: boolean; signedIn?: boolean; respond?: () => Response } = {}) {
  const store = new Map<string, string>();
  if (opts.signedIn !== false) {
    store.set("authToken", "header.payload.signature");
    store.set("userData", JSON.stringify({ id: "u1", email: "trainee@example.test" }));
  }
  const assign = vi.fn();
  const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (opts.respond ?? (() => json(401, EXPIRED)))());
  const target: SessionGuardTarget = {
    fetch: inner as unknown as typeof fetch,
    location: { origin: ORIGIN, pathname: opts.path ?? "/trainer", search: opts.search ?? "", assign },
  };
  const onExpired = vi.fn(() => { store.delete("authToken"); store.delete("userData"); });
  const uninstall = installSessionExpiryGuard(target, {
    isSignedIn: () => store.has("authToken"),
    isDemo: () => !!opts.demo,
    onExpired,
  });
  return { target, inner, assign, onExpired, store, uninstall };
}

beforeEach(() => resetSessionExpiryRedirect());

describe("isSessionGuardedUrl", () => {
  it.each(["/api/coach/turn", "/api/transcripts?limit=5", `${ORIGIN}/api/me`, "/api/sessions/abc/notes", "/api/authors", "/api/accessible"])(
    "guards %s",
    (url) => expect(isSessionGuardedUrl(url, ORIGIN)).toBe(true),
  );

  it.each([
    "/api/auth/login", "/api/auth/mfa/challenge", "/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password",
    "/api/auth/session", "/api/auth/logout", "/api/auth/google", "/api/auth/google/status", "/api/auth", "/api/access", "/api/access/check",
  ])("excludes %s", (url) => expect(isSessionGuardedUrl(url, ORIGIN)).toBe(false));

  it.each(["https://elsewhere.example.test/api/coach/turn", "http://trainer.example.test/api/coach/turn", "//elsewhere.example.test/api/me"])(
    "ignores cross-origin %s",
    (url) => expect(isSessionGuardedUrl(url, ORIGIN)).toBe(false),
  );

  it.each(["/trainer", "/apis/x", "/api", "/login"])("ignores non-API path %s", (url) => expect(isSessionGuardedUrl(url, ORIGIN)).toBe(false));

  it("resolves dot segments before matching", () => {
    expect(isSessionGuardedUrl("/api/coach/../auth/login", ORIGIN)).toBe(false);
  });
});

describe("isSessionExpiryBody and responseIsSessionExpiry", () => {
  it("accepts only requireAuth's two session errors", () => {
    expect(isSessionExpiryBody(EXPIRED)).toBe(true);
    expect(isSessionExpiryBody(MISSING)).toBe(true);
    for (const b of [{ error: "access_code_required" }, { error: "forbidden" }, { error: "invalid_credentials" }, { message: "Authentication required" }, null, "Authentication required", { error: 401 }]) {
      expect(isSessionExpiryBody(b)).toBe(false);
    }
  });

  it("reads 401 bodies, rejects other statuses, non-JSON and oversized bodies", async () => {
    expect(await responseIsSessionExpiry(json(401, MISSING))).toBe(true);
    expect(await responseIsSessionExpiry(json(401, { error: "access_code_required" }))).toBe(false);
    expect(await responseIsSessionExpiry(json(403, EXPIRED))).toBe(false);
    expect(await responseIsSessionExpiry(json(500, EXPIRED))).toBe(false);
    expect(await responseIsSessionExpiry(new Response("Authentication required", { status: 401 }))).toBe(false);
    expect(await responseIsSessionExpiry(new Response(null, { status: 401 }))).toBe(false);
    expect(await responseIsSessionExpiry(json(401, { ...EXPIRED, pad: "x".repeat(5000) }))).toBe(false);
  });
});

describe("expiredLoginHref", () => {
  const next = (href: string | null) => (href ? new URL(href, ORIGIN).searchParams.get("next") : undefined);

  it("carries the current path and query as next", () => {
    const href = expiredLoginHref("/trainer", "?scenario=auto-inbound-used-crossover-lead&mode=text");
    expect(href).toMatch(/^\/login\?/);
    expect(next(href)).toBe("/trainer?scenario=auto-inbound-used-crossover-lead&mode=text");
    expect(new URL(href!, ORIGIN).searchParams.get("reason")).toBe("expired");
    expect(next(expiredLoginHref("/dashboard", ""))).toBe("/dashboard");
  });

  it("drops a next that fails validNextPath", () => {
    expect(next(expiredLoginHref("//evil.example.test", ""))).toBeNull();
    expect(next(expiredLoginHref("/trainer", "?q=" + "a".repeat(250)))).toBeNull();
    expect(next(expiredLoginHref("/trainer\\x", ""))).toBeNull();
    expect(expiredLoginHref("//evil.example.test", "")).toBe("/login?reason=expired");
  });

  it("does not redirect on /login itself", () => {
    expect(expiredLoginHref("/login", "")).toBeNull();
    expect(expiredLoginHref("/login", "?next=%2Ftrainer")).toBeNull();
  });

  it.each(["/register", "/forgot-password", "/reset-password", "/access"])("goes to /login with no next from %s", (path) => {
    expect(expiredLoginHref(path, "?plan=pro")).toBe("/login?reason=expired");
  });
});

describe("installSessionExpiryGuard", () => {
  it("clears the session and redirects once with next, leaving the caller's body readable", async () => {
    const { target, assign, onExpired, store } = setup({ path: "/trainer", search: "?scenario=x&mode=text" });
    const res = await target.fetch("/api/coach/turn", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(EXPIRED);
    await settle();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(store.has("authToken")).toBe(false);
    expect(store.has("userData")).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/trainer?scenario=x&mode=text")}&reason=expired`);
  });

  it("redirects at most once under parallel 401s", async () => {
    const { target, assign } = setup();
    await Promise.all(["/api/coach/turn", "/api/transcripts", "/api/me", "/api/team"].map((u) => target.fetch(u)));
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("stays put after a redirect even if the session comes back before the next 401", async () => {
    const { target, assign, store } = setup();
    await target.fetch("/api/coach/turn");
    await settle();
    store.set("authToken", "header.payload.signature");
    await target.fetch("/api/coach/turn");
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an excluded auth route", "/api/auth/login", () => json(401, { error: "Invalid email or password" })],
    ["the access gate", "/api/access", () => json(401, MISSING)],
    ["the proxy's access-code 401", "/api/coach/turn", () => json(401, { error: "access_code_required" })],
    ["a 403", "/api/coach/turn", () => json(403, EXPIRED)],
    ["a 500", "/api/coach/turn", () => json(500, EXPIRED)],
    ["a cross-origin 401", "https://elsewhere.example.test/api/coach/turn", () => json(401, EXPIRED)],
  ])("does nothing for %s", async (_label, url, respond) => {
    const { target, assign, onExpired, store } = setup({ respond });
    await target.fetch(url);
    await settle();
    expect(onExpired).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(store.has("authToken")).toBe(true);
  });

  it("does nothing when signed out client-side", async () => {
    const { target, assign, onExpired } = setup({ signedIn: false });
    await target.fetch("/api/coach/turn");
    await settle();
    expect(onExpired).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does nothing in demo mode", async () => {
    const { target, assign, onExpired, store } = setup({ demo: true });
    await target.fetch("/api/coach/turn");
    await settle();
    expect(onExpired).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(store.has("authToken")).toBe(true);
  });

  it("clears the session but does not navigate when already on /login", async () => {
    const { target, assign, onExpired } = setup({ path: "/login", search: "?next=%2Ftrainer" });
    await target.fetch("/api/me");
    await settle();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("works with Request and URL inputs and passes init through", async () => {
    const { target, inner, assign } = setup();
    const init = { method: "POST", body: "{}" };
    await target.fetch(new URL(`${ORIGIN}/api/coach/turn`), init);
    expect(inner).toHaveBeenCalledWith(expect.any(URL), init);
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    resetSessionExpiryRedirect();
    await target.fetch(new Request(`${ORIGIN}/api/transcripts`));
    await settle();
    expect(assign).toHaveBeenCalledTimes(1); // already signed out by the first 401
  });

  it("is idempotent and the uninstaller restores the original fetch", async () => {
    const s = setup();
    const wrapped = s.target.fetch;
    const second = installSessionExpiryGuard(s.target, { isSignedIn: () => true, isDemo: () => false, onExpired: vi.fn() });
    expect(s.target.fetch).toBe(wrapped);
    second();
    expect(s.target.fetch).toBe(wrapped);
    s.uninstall();
    expect(s.target.fetch).toBe(s.inner);
  });

  it("returns the caller's response untouched on success", async () => {
    const { target, assign } = setup({ respond: () => json(200, { ok: true }) });
    const res = await target.fetch("/api/coach/turn");
    expect(await res.json()).toEqual({ ok: true });
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("AuthProvider wiring (source check; no DOM test library in this repo)", () => {
  const SRC = readFileSync("src/contexts/AuthContext.tsx", "utf8");
  it("installs the guard on window with clearSession, a localStorage sign-in check and the demo flag", () => {
    expect(SRC).toMatch(/installSessionExpiryGuard\(window, \{\s*isSignedIn: \(\) => !!localStorage\.getItem\("authToken"\),\s*isDemo: \(\) => demoModeRef\.current,\s*onExpired: clearSession,\s*\}\)/);
    expect(SRC).toContain("demoModeRef.current = !!caps?.demoMode;");
  });
});
