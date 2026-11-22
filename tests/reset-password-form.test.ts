import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ capabilities: null }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

import ResetPasswordForm from "@/components/ResetPasswordForm";
import { RESET_INVALID_MESSAGE } from "@/lib/passwordReset-types";
import { applyCheckResult, checkOutcome, fetchResetCheck, RESET_CHECK_PATH, resetView } from "@/lib/resetLinkCheck";

const TOKEN = "v1.abc.123.fp.sig";

describe("checkOutcome", () => {
  it("is valid or invalid only for a 200 with a boolean valid", () => {
    expect(checkOutcome(200, { valid: true })).toBe("valid");
    expect(checkOutcome(200, { valid: false })).toBe("invalid");
  });

  it.each<[number, unknown]>([
    [429, { error: "rate_limited" }],
    [429, { valid: false }],
    [500, { error: "check_failed" }],
    [503, { error: "database_not_configured" }],
    [400, { valid: false }],
    [200, undefined],
    [200, null],
    [200, "not json"],
    [200, {}],
    [200, { valid: "false" }],
    [200, { valid: 0 }],
  ])("is unknown for status %s with body %j", (status, body) => expect(checkOutcome(status, body)).toBe("unknown"));
});

describe("resetView (one instance, one token)", () => {
  it("shows the invalid state with no token", () => {
    expect(resetView("", null)).toBe("no-token");
    expect(resetView("", "valid")).toBe("no-token");
  });

  it("is checking until the check answers", () => expect(resetView(TOKEN, null)).toBe("checking"));

  it("shows invalid only for invalid; valid and unknown show the form", () => {
    expect(resetView(TOKEN, "invalid")).toBe("invalid");
    expect(resetView(TOKEN, "valid")).toBe("form");
    expect(resetView(TOKEN, "unknown")).toBe("form");
  });
});

describe("applyCheckResult (invalid is sticky)", () => {
  it("takes the check answer when nothing marked the link invalid", () => {
    expect(applyCheckResult(null, "valid")).toBe("valid");
    expect(applyCheckResult(null, "invalid")).toBe("invalid");
    expect(applyCheckResult(null, "unknown")).toBe("unknown");
  });

  it("never replaces invalid: a late valid or unknown after a confirm invalid_token stays invalid", () => {
    expect(applyCheckResult("invalid", "valid")).toBe("invalid");
    expect(applyCheckResult("invalid", "unknown")).toBe("invalid");
    expect(resetView(TOKEN, applyCheckResult("invalid", "valid"))).toBe("invalid");
  });
});

describe("fetchResetCheck", () => {
  const reply = (status: number, body: string) =>
    vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("POSTs JSON { token } to the check route with no token in the URL", async () => {
    const fake = reply(200, '{"valid":true}');
    const signal = new AbortController().signal;
    await fetchResetCheck(TOKEN, fake, signal);
    const [url, init] = vi.mocked(fake).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESET_CHECK_PATH);
    expect(url).toBe("/api/auth/password-reset/check");
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(init.signal).toBe(signal);
  });

  it.each<[string, typeof fetch, string]>([
    ["valid", reply(200, '{"valid":true}'), "valid"],
    ["invalid", reply(200, '{"valid":false}'), "invalid"],
    ["429", reply(429, '{"error":"rate_limited"}'), "unknown"],
    ["500", reply(500, '{"error":"check_failed"}'), "unknown"],
    ["non-JSON body", reply(200, "<html>proxy error</html>"), "unknown"],
    ["network rejection", vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch, "unknown"],
  ])("maps %s", async (_name, fake, expected) => {
    expect(await fetchResetCheck(TOKEN, fake)).toBe(expected);
  });
});

describe("ResetPasswordForm", () => {
  // Static render runs no effects, so a token renders the checking state and no token renders the invalid state.
  const html = () => renderToStaticMarkup(createElement(ResetPasswordForm));
  const source = readFileSync(join(__dirname, "..", "src/components/ResetPasswordForm.tsx"), "utf8");

  beforeEach(() => {
    mocks.query = "";
  });

  it("shows the checking state, not the form, while a link is being checked", () => {
    mocks.query = `token=${TOKEN}`;
    const h = html();
    expect(h).toContain("Checking your link");
    expect(h).not.toContain("<form");
    expect(h).not.toContain('type="password"');
  });

  it("keeps the invalid-link state when there is no token", () => {
    const h = html();
    expect(h).toContain("Reset link not valid");
    expect(h).toContain(RESET_INVALID_MESSAGE);
    expect(h).toContain('href="/forgot-password"');
    expect(h).not.toContain("Checking your link");
  });

  it("mounts a fresh instance per token, so no state crosses links", () => {
    expect(source).toContain('const token = useSearchParams().get("token") ?? "";');
    expect(source).toContain("<ResetPasswordInstance key={token} token={token} />");
    expect(source.match(/useSearchParams\(\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/tokenRef|StoredCheck|applySubmitInvalid|setCheck\(null\)/);
  });

  it("wires the tested helpers, aborts on unmount and ignores late check and confirm replies", () => {
    expect(source).toContain('from "@/lib/resetLinkCheck"');
    expect(source).toContain("const view = resetView(token, outcome);");
    expect(source).toContain("fetchResetCheck(token, fetch, controller.signal)");
    expect(source).toContain("if (!controller.signal.aborted) setOutcome((prev) => applyCheckResult(prev, result));");
    expect(source).toContain("return () => controller.abort();");
    expect(source).toContain("const gone = () => !life.current || life.current.signal.aborted;");
    // Confirm: no redirect, error or state change once unmounted.
    expect(source.match(/if \(gone\(\)\) return;/g)).toHaveLength(2);
    expect(source.indexOf("if (gone()) return;")).toBeLessThan(source.indexOf('router.replace("/login?reset=1")'));
    expect(source).toContain("if (!gone()) setError(");
    expect(source).toContain("if (!gone()) setBusy(false);");
    expect(source).not.toContain("/api/auth/password-reset/check");
  });
});
