import { describe, expect, it, vi } from "vitest";
import {
  accessHref, buildRegisterPayload, createSubmitter, DRAFT_KEY, EMPTY_VALUES, GENERIC_FAILURE, loadDraft, mapServerError,
  NETWORK_FAILURE, PASSWORD_MIN, saveDraft, summaryItems, validateRegister, visibleFields, type RegisterValues,
} from "@/lib/registerForm";

// Fictional details only.
const good: RegisterValues = {
  firstName: "Mia", lastName: "Chen", email: "mia@example.test", password: "correct-horse-battery", orgName: "Mia's practice", orgCode: "",
};

/** A promise the test resolves or rejects by hand, to hold a request "in flight". */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("validateRegister", () => {
  it("accepts a complete create form and a complete join form", () => {
    expect(validateRegister(good, "create")).toEqual({});
    expect(validateRegister({ ...good, orgName: "", orgCode: "123456" }, "join")).toEqual({});
  });

  it("flags every empty required field with a plain message", () => {
    const e = validateRegister(EMPTY_VALUES, "create");
    expect(Object.keys(e)).toEqual(["firstName", "lastName", "email", "password", "orgName"]);
    expect(e.firstName).toBe("Enter your first name.");
    expect(e.email).toBe("Enter your email address.");
  });

  it("rejects an invalid email", () => {
    for (const email of ["mia", "mia@", "mia@example", "mia example@test.io", "@example.test"]) {
      expect(validateRegister({ ...good, email }, "create").email, email).toBe("Enter an email address like name@example.com.");
    }
    expect(validateRegister({ ...good, email: "  mia@example.test " }, "create").email).toBeUndefined();
  });

  it("rejects a password under the minimum, which is 10", () => {
    expect(PASSWORD_MIN).toBe(10);
    expect(validateRegister({ ...good, password: "123456789" }, "create").password).toBe("Use at least 10 characters for your password.");
    expect(validateRegister({ ...good, password: "1234567890" }, "create").password).toBeUndefined();
  });

  it("requires a team name in create mode, and ignores it in join mode", () => {
    expect(validateRegister({ ...good, orgName: "   " }, "create").orgName).toMatch(/^Enter a team name/);
    expect(validateRegister({ ...good, orgName: "A" }, "create").orgName).toBe("Use at least 2 characters for the team name.");
    expect(validateRegister({ ...good, orgName: "", orgCode: "4821" }, "join").orgName).toBeUndefined();
  });

  it("requires a 3 to 8 digit team code in join mode, and ignores it in create mode", () => {
    expect(validateRegister({ ...good, orgCode: "" }, "join").orgCode).toBe("Enter your team code. Ask your team owner for it.");
    for (const code of ["12", "123456789", "12a456"]) expect(validateRegister({ ...good, orgCode: code }, "join").orgCode, code).toMatch(/3 to 8 digits/);
    expect(validateRegister({ ...good, orgCode: "12" }, "create").orgCode).toBeUndefined();
  });

  it("lists only the fields a mode shows", () => {
    expect(visibleFields("create")).toEqual(["firstName", "lastName", "email", "password", "orgName"]);
    expect(visibleFields("join")).toEqual(["firstName", "lastName", "email", "password", "orgCode"]);
  });
});

describe("buildRegisterPayload keeps the existing request shape", () => {
  it("sends newOrgName in create mode and joinOrgCode in join mode, never both", () => {
    const values = { ...good, orgCode: "654321" };
    expect(buildRegisterPayload(values, "create", {})).toEqual({
      firstName: "Mia", lastName: "Chen", email: "mia@example.test", password: "correct-horse-battery", newOrgName: "Mia's practice",
    });
    expect(buildRegisterPayload(values, "join", {})).toEqual({
      firstName: "Mia", lastName: "Chen", email: "mia@example.test", password: "correct-horse-battery", joinOrgCode: "654321",
    });
  });

  it("carries the whitelisted sign-up intent and trims email and team code", () => {
    const p = buildRegisterPayload({ ...good, email: " mia@example.test ", orgCode: " 654321 " }, "join", { plan: "pro", interval: "year", src: "pricing" });
    expect(p).toMatchObject({ email: "mia@example.test", joinOrgCode: "654321", plan: "pro", interval: "year", src: "pricing" });
    expect(p).not.toHaveProperty("newOrgName");
    expect(p).not.toHaveProperty("phone");
  });
});

describe("mapServerError uses the route's existing answers", () => {
  it("taken email goes to the email field", () => {
    expect(mapServerError("An account with this email already exists", "create")).toEqual({
      field: "email", message: "An account with this email already exists. Sign in instead, or use another email.",
    });
  });

  it("an unknown team code goes to the team code field", () => {
    expect(mapServerError("Unknown organization code.", "join")).toMatchObject({ field: "orgCode", message: expect.stringMatching(/^No team uses that code/) });
  });

  it("the access gate asks for the access code, from the route or the proxy", () => {
    for (const raw of ["invite code required", "access_code_required"]) {
      expect(mapServerError(raw, "create")).toEqual({ message: expect.stringMatching(/invite-only/), accessLink: true });
    }
  });

  it("a missing team name maps to the visible team field", () => {
    const refine = "Either joinOrgCode or newOrgName must be provided (but not both).";
    expect(mapServerError(refine, "create").field).toBe("orgName");
    expect(mapServerError(refine, "join").field).toBe("orgCode");
  });

  it("maps a short password, a bad email, rate limits and network errors to plain messages", () => {
    expect(mapServerError("Password must be at least 10 characters", "create").field).toBe("password");
    expect(mapServerError("Invalid email", "create").field).toBe("email");
    expect(mapServerError("Too many registration attempts. Please try again shortly.", "create").message).toMatch(/Wait a minute/);
    for (const raw of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(mapServerError(raw, "create")).toEqual({ message: NETWORK_FAILURE });
    }
  });

  it("never shows raw or unknown text", () => {
    for (const raw of ["Registration failed. Please try again.", "Registration failed", "", "String must contain at least 2 character(s), Invalid"]) {
      expect(mapServerError(raw, "create")).toEqual({ message: GENERIC_FAILURE });
    }
  });

  it("links back to this sign-up through the access page, same-origin only", () => {
    expect(accessHref("/register?plan=pro")).toBe("/access?next=%2Fregister%3Fplan%3Dpro");
    expect(accessHref("//evil.example")).toBe("/access?next=%2Fregister");
    expect(accessHref("https://evil.example")).toBe("/access?next=%2Fregister");
  });
});

describe("createSubmitter: pending, double submit and retry", () => {
  it("never shows pending for a form that fails validation, and sends nothing", async () => {
    const register = vi.fn();
    const pending = vi.fn();
    const submit = createSubmitter(register, pending);
    const out = await submit({ ...good, email: "nope" }, "create", {});
    expect(out).toEqual({ kind: "invalid", errors: { email: "Enter an email address like name@example.com." } });
    expect(register).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
  });

  it("turns pending on only when a slow request starts, and ignores a second submit while it runs", async () => {
    const d = deferred();
    const register = vi.fn(() => d.promise);
    const pending = vi.fn();
    const submit = createSubmitter(register, pending);
    expect(pending).not.toHaveBeenCalled();
    const first = submit(good, "create", {});
    expect(register).toHaveBeenCalledOnce();
    expect(pending.mock.calls).toEqual([[true]]);
    expect(await submit(good, "create", {})).toEqual({ kind: "ignored" });
    expect(register).toHaveBeenCalledOnce();
    d.resolve();
    expect(await first).toEqual({ kind: "ok" });
    // Success keeps the pending state while the page redirects, and a late click cannot register twice.
    expect(pending.mock.calls).toEqual([[true]]);
    expect(await submit(good, "create", {})).toEqual({ kind: "ignored" });
  });

  it("after a failure turns pending off, keeps the values and lets the same values retry", async () => {
    const values = { ...good };
    const snapshot = JSON.stringify(values);
    const register = vi.fn()
      .mockRejectedValueOnce(new Error("Registration failed. Please try again."))
      .mockResolvedValueOnce(undefined);
    const pending = vi.fn();
    const submit = createSubmitter(register, pending);
    expect(await submit(values, "create", {})).toEqual({ kind: "failed", error: { message: GENERIC_FAILURE } });
    expect(pending.mock.calls).toEqual([[true], [false]]);
    expect(JSON.stringify(values)).toBe(snapshot);
    expect(await submit(values, "create", {})).toEqual({ kind: "ok" });
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1][0]).toEqual(register.mock.calls[0][0]);
  });

  it("maps a taken email and a bad team code from the server to their fields", async () => {
    const register = vi.fn()
      .mockRejectedValueOnce(new Error("An account with this email already exists"))
      .mockRejectedValueOnce(new Error("Unknown organization code."));
    const submit = createSubmitter(register, () => {});
    expect(await submit(good, "create", {})).toMatchObject({ kind: "failed", error: { field: "email" } });
    expect(await submit({ ...good, orgCode: "999999" }, "join", {})).toMatchObject({ kind: "failed", error: { field: "orgCode" } });
  });

  it("maps a network failure (fetch TypeError) to a retry message", async () => {
    const submit = createSubmitter(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), () => {});
    expect(await submit(good, "create", {})).toEqual({ kind: "failed", error: { message: NETWORK_FAILURE } });
  });
});

describe("summaryItems: no failure goes unseen", () => {
  it("lists visible field errors as links, in DOM order", () => {
    expect(summaryItems({ password: "p", email: "e" }, "create")).toEqual([
      { field: "email", message: "e", linked: true },
      { field: "password", message: "p", linked: true },
    ]);
    expect(summaryItems({}, "join")).toEqual([]);
  });

  it("keeps a bad team code visible as text when the mode changed to create while the request ran", async () => {
    // Join with an unknown code; the answer arrives after the rep picked Start a new team.
    const d = deferred();
    const submit = createSubmitter(() => d.promise, () => {});
    const pendingOut = submit({ ...good, orgName: "", orgCode: "999999" }, "join", {});
    d.reject(new Error("Unknown organization code."));
    const out = await pendingOut;
    expect(out).toMatchObject({ kind: "failed", error: { field: "orgCode" } });
    const error = (out as { error: { field: "orgCode"; message: string } }).error;
    const items = summaryItems({ [error.field]: error.message }, "create");
    expect(items).toEqual([{ field: "orgCode", message: error.message, linked: false }]);
    // Back in join mode it is a normal linked error again.
    expect(summaryItems({ [error.field]: error.message }, "join")).toEqual([{ field: "orgCode", message: error.message, linked: true }]);
  });

  it("puts hidden-field errors after the visible ones", () => {
    expect(summaryItems({ orgName: "team", email: "e" }, "join").map((i) => [i.field, i.linked])).toEqual([["email", true], ["orgName", false]]);
  });
});

describe("sign-up draft", () => {
  it("keeps values for browser back and mode switches, but never stores the password", () => {
    const store = memoryStore();
    saveDraft("join", { ...good, orgCode: "4821" }, store);
    expect(store.m.get(DRAFT_KEY)).not.toContain("correct-horse-battery");
    expect(store.m.get(DRAFT_KEY)).not.toContain("password");
    const d = loadDraft(store)!;
    expect(d.mode).toBe("join");
    // Both team fields are kept, so switching back and forth loses nothing.
    expect(d.values).toEqual({ firstName: "Mia", lastName: "Chen", email: "mia@example.test", orgName: "Mia's practice", orgCode: "4821" });
    expect(d.values).not.toHaveProperty("password");
  });

  it("drops junk, bounds lengths and survives blocked storage", () => {
    const store = memoryStore();
    store.setItem(DRAFT_KEY, JSON.stringify({ mode: "admin", values: { firstName: "x".repeat(500), email: 5, password: "leak" } }));
    const d = loadDraft(store)!;
    expect(d.mode).toBe("create");
    expect(d.values.firstName).toHaveLength(80);
    expect(d.values.email).toBe("");
    expect(d.values).not.toHaveProperty("password");
    store.setItem(DRAFT_KEY, "{not json");
    expect(loadDraft(store)).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(loadDraft(blocked)).toBeNull();
    expect(() => saveDraft("create", good, blocked)).not.toThrow();
  });
});
