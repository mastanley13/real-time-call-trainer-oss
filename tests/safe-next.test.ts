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
  "/%2F/apix",
  "/%252Fapi-docs",
  "/x/%2E%2E/apis/y",
  "/api/../trainer",
  "/trainer?q=%ZZ", // the query is not decoded, so a malformed escape there is left alone
  "/trainer/%20x", // single-encoded page paths are ordinary
  "/scenarios/caf%C3%A9",
  "/x/%252520y", // triple-encoded still resolves within the three passes
  "/trainer?q=%25252561pi", // depth limit applies to the path only
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

// A malformed percent escape anywhere in the pathname, at any decode pass, falls back. A real page link never
// carries one, and stopping the decode there would hide an API path in front of it.
const MALFORMED = [
  "/%61pi/%ZZ",
  "/trainer/%ZZ",
  "/%E0%A4%A",
  "/%E0/x",
  "/%E0/api",
  "/library/%",
  "/%25ZZ", // decodes to "/%ZZ" on the first pass, then fails on the second
];

describe("safeNextPath rejects malformed percent escapes in the path", () => {
  it.each(MALFORMED)("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/trainer");
    expect(safeNextPath(bad, "/dashboard")).toBe("/dashboard");
    expect(validNextPath(bad)).toBeNull();
    expect(loginDestination(bad)).toBe("/trainer");
    expect(signInHref(bad)).toBe("/login");
  });
});

// Encoded more deeply than the decode pass limit (3): any "%" left after the last pass falls back, so a fourth
// decode can never reveal an API path or a malformed escape.
const TOO_DEEP = [
  "/%25252561pi/x", // "/%61pi/x" after three passes, "/api/x" after four
  "/x/%252525ZZ", // "/x/%ZZ" after three passes, malformed on the fourth
  "/x/%25252520y", // harmless after four, but still holds a "%" after three
];

describe("safeNextPath rejects paths encoded beyond the decode limit", () => {
  it.each(TOO_DEEP)("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/trainer");
    expect(safeNextPath(bad, "/dashboard")).toBe("/dashboard");
    expect(validNextPath(bad)).toBeNull();
    expect(loginDestination(bad)).toBe("/trainer");
    expect(signInHref(bad)).toBe("/login");
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

// Protocol-relative and absolute URLs never pass as a post-login next, even when they name a page we would
// otherwise keep. The early "//" check is what stops "//evil.com" before the origin test; encoded look-alikes
// that stay on the same origin ("/%2F%2Fevil.com") are ordinary paths and are kept.
const PROTOCOL_RELATIVE = [
  "//evil.com",
  "//evil.com/trainer",
  "///trainer",
  "////api",
  "//google.com",
  "https://evil.com",
  "http://evil.com",
  "https://calltrainer.tech/trainer",
  "//evil.com/%2Fapi",
  "/\\evil.com",
  "javascript:alert(1)",
  "trainer",
];

describe("safeNextPath rejects protocol-relative and off-site next values", () => {
  it.each(PROTOCOL_RELATIVE)("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/trainer");
    expect(safeNextPath(bad, "/dashboard")).toBe("/dashboard");
    expect(validNextPath(bad)).toBeNull();
    expect(loginDestination(bad)).toBe("/trainer");
    expect(signInHref(bad)).toBe("/login");
  });

  it("keeps an encoded look-alike that stays on this origin", () => {
    expect(safeNextPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
    expect(validNextPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });
});
