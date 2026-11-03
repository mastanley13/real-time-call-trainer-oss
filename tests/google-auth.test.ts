import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { authorizeUrl, checkIdTokenClaims, googleConfig, pkceChallenge, safeNextPath, signFlowState, verifyFlowState } from "@/lib/googleAuth";

const NOW = 1_800_000_000;
const good = {
  iss: "https://accounts.google.com", aud: "client-1", exp: NOW + 300, sub: "1234567890",
  email: "Rep@Example.test", email_verified: true, nonce: "nonce-abcdefghijklmnop", given_name: "Ravi", family_name: "Shah",
};
const expect_ = { clientId: "client-1", nonce: "nonce-abcdefghijklmnop", nowSec: NOW };

const saved = { ...process.env };
beforeEach(() => {
  process.env.JWT_SECRET = "test-secret-0123456789abcdef0123456789";
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.GOOGLE_CLIENT_SECRET = "secret-1";
  delete process.env.DEMO_MODE;
  delete process.env.APP_URL;
});
afterEach(() => { process.env = { ...saved }; });

describe("checkIdTokenClaims", () => {
  it("accepts a fresh, verified token for this client and lowercases the email", () => {
    const r = checkIdTokenClaims(good, expect_);
    expect(r).toEqual({ ok: true, profile: { sub: "1234567890", email: "rep@example.test", firstName: "Ravi", lastName: "Shah" } });
    expect(checkIdTokenClaims({ ...good, iss: "accounts.google.com", aud: ["other", "client-1"], email_verified: "true" }, expect_).ok).toBe(true);
  });
  it.each([
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "someone-else" }],
    ["expired", { exp: NOW }],
    ["nonce", { nonce: "replayed-nonce-0000000" }],
    ["email_unverified", { email_verified: false }],
    ["email_unverified", { email_verified: undefined }],
    ["malformed", { email: "not-an-email" }],
  ])("rejects %s", (reason, patch) => {
    expect(checkIdTokenClaims({ ...good, ...patch }, expect_)).toEqual({ ok: false, reason });
  });
  it("rejects junk", () => {
    expect(checkIdTokenClaims(null, expect_).ok).toBe(false);
    expect(checkIdTokenClaims("x", expect_).ok).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths only", () => {
    expect(safeNextPath("/team")).toBe("/team");
    expect(safeNextPath("/library?x=1")).toBe("/library?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "team", "", null, "/a\r\nSet-Cookie: x"]) {
      expect(safeNextPath(bad)).toBe("/trainer");
    }
  });
});

describe("flow cookie and authorize URL", () => {
  const flow = { state: "state-0123456789abcdef", verifier: "v".repeat(64), nonce: "nonce-0123456789abcdef", next: "/team", joinCode: "123456", managerId: "mia" };
  it("round-trips the signed flow state and rejects tampering", () => {
    const token = signFlowState(flow);
    expect(verifyFlowState(token)).toEqual(flow);
    expect(verifyFlowState(undefined)).toBeNull();
    expect(verifyFlowState(token.slice(0, -2) + "xx")).toBeNull();
    // A session JWT signed with the same secret is not a flow cookie.
    expect(verifyFlowState(jwt.sign({ ...flow }, process.env.JWT_SECRET!))).toBeNull();
  });
  it("asks Google for openid email profile with PKCE S256, state and nonce", () => {
    const cfg = googleConfig("http://localhost:3000")!;
    expect(cfg.redirectUri).toBe("http://localhost:3000/api/auth/google/callback");
    const url = new URL(authorizeUrl(cfg, flow));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(flow.verifier));
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.toString()).not.toContain("secret-1");
  });
  it("pins the callback to APP_URL and is off without keys or in demo mode", () => {
    process.env.APP_URL = "https://calltrainer.example/";
    expect(googleConfig("http://spoofed.example")!.redirectUri).toBe("https://calltrainer.example/api/auth/google/callback");
    process.env.DEMO_MODE = "true";
    expect(googleConfig("http://localhost:3000")).toBeNull();
    delete process.env.DEMO_MODE;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(googleConfig("http://localhost:3000")).toBeNull();
  });
});
