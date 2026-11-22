import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOTH_ORG_FIELDS_MESSAGE,
  hasBothOrgFields,
  REGISTER_FALLBACK_MESSAGE,
  registerErrorBody,
  registerOrgFields,
} from "@/lib/registerForm";

describe("registerOrgFields (the org part of the /register body)", () => {
  it("join mode sends only joinOrgCode, even with a team name typed before switching", () => {
    expect(registerOrgFields("join", "Example Team", "654321")).toEqual({ joinOrgCode: "654321" });
    expect(registerOrgFields("join", "", "654321")).toEqual({ joinOrgCode: "654321" });
  });

  it("create mode sends only newOrgName, even with an invite code prefilled", () => {
    expect(registerOrgFields("create", "Example Team", "654321")).toEqual({ newOrgName: "Example Team" });
  });

  it("create mode with a blank team name sends neither", () => {
    for (const blank of ["", "   ", "\t"]) expect(registerOrgFields("create", blank, "654321")).toEqual({});
  });

  it("is what the register page spreads into the body, with no other org fields", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toContain("...registerOrgFields(mode, f.orgName, f.orgCode),");
    // No other place puts the org fields into the request.
    expect(src.match(/newOrgName|joinOrgCode/g)).toBeNull();
    expect(src.match(/\bregister\(\{/g)).toHaveLength(1);
  });
});

describe("hasBothOrgFields", () => {
  it("is true for a join code with a non-blank team name, whatever else is wrong", () => {
    expect(hasBothOrgFields({ joinOrgCode: "654321", newOrgName: "Example Team" })).toBe(true);
    expect(hasBothOrgFields({ joinOrgCode: "12ab", newOrgName: "A" })).toBe(true);
  });

  it("is false when either is missing, empty or blank, or the body is not an object", () => {
    for (const raw of [
      { joinOrgCode: "654321" }, { newOrgName: "Example Team" }, { joinOrgCode: "654321", newOrgName: "   " },
      { joinOrgCode: "", newOrgName: "Example Team" }, { joinOrgCode: 654321, newOrgName: "Example Team" },
      null, undefined, "x", [],
    ]) expect(hasBothOrgFields(raw)).toBe(false);
  });
});

describe("registerErrorBody", () => {
  const issue = (field: string, code = "too_small") => ({ code, path: [field] });

  it("maps each field to its friendly message", () => {
    const cases: [string, string][] = [
      ["firstName", "Enter your first name."],
      ["lastName", "Enter your last name."],
      ["email", "Enter a valid email address."],
      ["phone", "Enter a valid phone number."],
      ["password", "Password must be at least 10 characters."],
      ["joinOrgCode", "Enter a valid join code."],
      ["newOrgName", "Team names need at least 2 characters."],
    ];
    for (const [field, message] of cases) {
      expect(registerErrorBody([issue(field)])).toEqual({ error: message, fieldErrors: { [field]: message } });
    }
  });

  it("uses length wording for too-long values", () => {
    expect(registerErrorBody([issue("firstName", "too_big")]).error).toBe("First names can be up to 80 characters.");
    expect(registerErrorBody([issue("password", "too_big")]).error).toBe("Passwords can be up to 200 characters.");
    expect(registerErrorBody([issue("newOrgName", "too_big")]).error).toBe("Team names can be up to 120 characters.");
    expect(registerErrorBody([issue("email", "too_big")]).error).toBe("Enter a valid email address.");
  });

  it("picks the first field in form order and keeps one message per field", () => {
    const out = registerErrorBody([issue("password"), issue("email", "invalid_string"), issue("email", "too_big"), issue("firstName")]);
    expect(out.error).toBe("Enter your first name.");
    expect(out.fieldErrors).toEqual({
      firstName: "Enter your first name.",
      email: "Enter a valid email address.",
      password: "Password must be at least 10 characters.",
    });
  });

  it("a join code with a team name sets the conflict on both team fields, and the top-level error follows form order", () => {
    const out = registerErrorBody([issue("newOrgName", "custom"), issue("lastName"), { code: "custom", path: [] }]);
    expect(out.error).toBe("Enter your last name.");
    expect(out.fieldErrors).toEqual({ lastName: "Enter your last name.", newOrgName: BOTH_ORG_FIELDS_MESSAGE, joinOrgCode: BOTH_ORG_FIELDS_MESSAGE });
    expect(registerErrorBody([issue("newOrgName", "custom"), { code: "custom", path: [] }]).error).toBe(BOTH_ORG_FIELDS_MESSAGE);
  });

  it("takes the conflict from the raw-body flag when Zod skipped its own check", () => {
    const out = registerErrorBody([{ code: "invalid_type", path: ["firstName"] }], true);
    expect(out).toEqual({
      error: "Enter your first name.",
      fieldErrors: { firstName: "Enter your first name.", joinOrgCode: BOTH_ORG_FIELDS_MESSAGE, newOrgName: BOTH_ORG_FIELDS_MESSAGE },
    });
    expect(registerErrorBody([], true)).toEqual({
      error: BOTH_ORG_FIELDS_MESSAGE,
      fieldErrors: { joinOrgCode: BOTH_ORG_FIELDS_MESSAGE, newOrgName: BOTH_ORG_FIELDS_MESSAGE },
    });
  });

  it("falls back to a generic message for anything that is not a known field", () => {
    expect(registerErrorBody([{ code: "invalid_type", path: [] }])).toEqual({ error: REGISTER_FALLBACK_MESSAGE, fieldErrors: {} });
    expect(registerErrorBody([issue("plan"), issue("__proto__")])).toEqual({ error: REGISTER_FALLBACK_MESSAGE, fieldErrors: {} });
    expect(registerErrorBody([])).toEqual({ error: REGISTER_FALLBACK_MESSAGE, fieldErrors: {} });
  });
});
