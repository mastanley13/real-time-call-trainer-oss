import { describe, expect, it } from "vitest";
import { loginDestination, safeNextPath, signInHref, validNextPath } from "@/lib/safeNext";

// Paths whose URL-normalized pathname is "/api" or under "/api/" never pass as a post-login next.
const API_NEXTS = [
  "/api/auth/google/callback?code=x",
  "/api",
  "/api/",
  "/api/me",
  "/api?x=1",
  "/api#x",
  "/api/?x=1#y",
  "/API/",
  "/Api/x",
  "/aPI",
  "/foo/../api/x",
  "/./api/x",
  "/trainer/../../api/x",
  "/%2e%2e/api/x",
  "/foo/%2E%2E/api",
  "/%61pi/x",
  "/%41%50%49",
  "/a%70i?x=1",
  "/%2Fapi",
  "/%2fapi/x",
  "/api%2Fx",
  // Encoded separators and dot segments anywhere in the path (whole-path decode, then resolve).
  "/%2F/api/x",
  "/%2f%2fapi",
  "//%2Fapi",
  "/%252Fapi/x",
  "/x/%2E%2E/api/y",
  "/%2E/api",
  "/%2561pi/x",
  "/%5Capi/x",
  "/..%2Fapi",
  "/x/..%2F..%2Fapi",
  "/%2E%2E%2F%2E%2E%2Fapi%2Fme",
];

// Ordinary page paths that only look similar keep passing.
const ALLOWED = [
  "/apix",
  "/api-docs",
  "/apis/x",
  "/ap",
  "/library/api",
  "/trainer/api/x",
  "/trainer?from=/api/x",
  "/trainer#/api/x",
  "/%E0/x",
  "/%E0/api",
  "/%2F/apix",
  "/%252Fapi-docs",
  "/x/%2E%2E/apis/y",
  "/api/../trainer",
  "/trainer?scenario=auto-inbound-used-crossover-lead&mode=text",
];

describe("safeNextPath rejects API routes", () => {
  it.each(API_NEXTS)("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/trainer");
    expect(safeNextPath(bad, "/dashboard")).toBe("/dashboard");
    expect(validNextPath(bad)).toBeNull();
    expect(loginDestination(bad)).toBe("/trainer");
    expect(signInHref(bad)).toBe("/login");
  });

  it("rejects the reported Google callback next", () => {
    const reported = "/api/auth/google/callback?code=x";
    expect(loginDestination(reported)).toBe("/trainer");
    expect(signInHref(reported)).toBe("/login");
    // Arriving as /login?next=<encoded> decodes to the same string.
    expect(loginDestination(new URLSearchParams("next=%2Fapi%2Fauth%2Fgoogle%2Fcallback%3Fcode%3Dx").get("next"))).toBe("/trainer");
  });
});

describe("safeNextPath keeps look-alike page paths", () => {
  it.each(ALLOWED)("keeps %j", (ok) => {
    expect(safeNextPath(ok)).toBe(ok);
    expect(validNextPath(ok)).toBe(ok);
    expect(loginDestination(ok)).toBe(ok);
    expect(signInHref(ok)).toBe(`/login?next=${encodeURIComponent(ok)}`);
  });
});
