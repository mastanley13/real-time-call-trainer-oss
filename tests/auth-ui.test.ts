import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS_COPY,
  LOGIN_PATH,
  SESSION_COPY,
  accountFormVisible,
  accountsState,
  canSubmitAccounts,
  canViewPrivate,
  guardedSubmit,
  loadConfig,
  performLogout,
} from "@/lib/authUi";

type Caps = { database: boolean; demoMode: boolean } | null;
const auth: { caps: Caps; configError: boolean; isLoading: boolean; isAuthenticated: boolean } = {
  caps: null,
  configError: false,
  isLoading: false,
  isAuthenticated: false,
};

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    capabilities: auth.caps,
    configError: auth.configError,
    retryConfig: vi.fn(),
    isAuthenticated: auth.isAuthenticated,
    isLoading: auth.isLoading,
    register: vi.fn(),
    login: vi.fn(),
    completeMfaChallenge: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: (p: { href: string; children?: unknown; className?: string }) => createElement("a", { href: p.href, className: p.className }, p.children as never),
}));

const NO_DB: Caps = { database: false, demoMode: false };
const WITH_DB: Caps = { database: true, demoMode: false };

async function render(page: "register" | "login", caps: Caps, configError = false) {
  auth.caps = caps;
  auth.configError = configError;
  const mod = page === "register" ? await import("@/app/register/page") : await import("@/app/login/page");
  return renderToStaticMarkup(createElement(mod.default));
}

/** Every input and button inside the form must be disabled, either itself or through its fieldset. */
function formIsLocked(html: string) {
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  const fieldset = /<fieldset[^>]*\sdisabled=""/.test(form);
  const submit = /<button[^>]*disabled=""[^>]*>(Create account|Sign in)/.test(form);
  return fieldset && submit;
}

describe("accountFormVisible", () => {
  it("is hidden while the session loads and when signed in", () => {
    expect(accountFormVisible({ isLoading: true, isAuthenticated: false })).toBe(false);
    expect(accountFormVisible({ isLoading: false, isAuthenticated: true })).toBe(false);
    expect(accountFormVisible({ isLoading: true, isAuthenticated: true, busy: true })).toBe(false);
  });
  it("is visible when signed out, and stays visible during a submit", () => {
    expect(accountFormVisible({ isLoading: false, isAuthenticated: false })).toBe(true);
    expect(accountFormVisible({ isLoading: true, isAuthenticated: false, busy: true })).toBe(true);
  });
});

describe("accounts state", () => {
  it("is loading until the server config is known", () => {
    expect(accountsState(null)).toBe("loading");
    expect(canSubmitAccounts(null)).toBe(false);
  });
  it("is unavailable with no database and no demo mode", () => {
    expect(accountsState(NO_DB)).toBe("unavailable");
    expect(canSubmitAccounts(NO_DB)).toBe(false);
  });
  it("is ready with a database", () => {
    expect(accountsState(WITH_DB)).toBe("ready");
    expect(canSubmitAccounts(WITH_DB)).toBe(true);
  });
});

describe("config failure", () => {
  it("is its own state even when placeholder capabilities claim a database", () => {
    expect(accountsState(WITH_DB, true)).toBe("error");
    expect(canSubmitAccounts(WITH_DB, true)).toBe(false);
  });
  it("blocks submission", () => {
    const run = vi.fn();
    expect(guardedSubmit({ preventDefault: vi.fn() }, WITH_DB, run, true)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("loadConfig reports non-OK, network and malformed responses as errors", async () => {
    expect(await loadConfig(async () => ({ ok: false, json: async () => ({}) }))).toEqual({ error: true });
    expect(await loadConfig(async () => { throw new Error("offline"); })).toEqual({ error: true });
    expect(await loadConfig(async () => ({ ok: true, json: async () => null }))).toEqual({ error: true });
    expect(await loadConfig(async () => ({ ok: true, json: async () => ({ nope: 1 }) }))).toEqual({ error: true });
  });
  it("loadConfig returns the capabilities on success", async () => {
    const caps = { database: false, demoMode: false };
    expect(await loadConfig(async () => ({ ok: true, json: async () => caps }))).toEqual({ caps });
  });
});

describe("guardedSubmit", () => {
  it.each([
    ["unknown", null],
    ["unavailable", NO_DB],
  ])("blocks submission when accounts are %s and still stops the browser submit", (_n, caps) => {
    const run = vi.fn();
    const preventDefault = vi.fn();
    expect(guardedSubmit({ preventDefault }, caps, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });
  it("runs the submit when accounts are ready", () => {
    const run = vi.fn();
    expect(guardedSubmit({ preventDefault: vi.fn() }, WITH_DB, run)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe.each(["register", "login"] as const)("%s page", (page) => {
  beforeEach(() => {
    auth.caps = null;
    auth.isLoading = false;
    auth.isAuthenticated = false;
  });

  it("disables every control itself, not only through the fieldset, while the check is pending", async () => {
    const html = await render(page, null);
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    const controls = form.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(2);
    for (const c of controls) expect(c).toMatch(/\sdisabled=""/);
  });

  it("hides the form while the stored session is unknown", async () => {
    auth.isLoading = true;
    const html = await render(page, WITH_DB);
    expect(html).toContain(SESSION_COPY.checking);
    expect(html).toMatch(/<form[^>]*\shidden=""/);
  });

  it("hides the form for a signed-in user who is being redirected", async () => {
    auth.isAuthenticated = true;
    const html = await render(page, WITH_DB);
    expect(html).toContain(SESSION_COPY.redirecting.replace("'", "&#x27;"));
    expect(html).toMatch(/<form[^>]*\shidden=""/);
  });

  it("shows the form once the session is known and signed out", async () => {
    const html = await render(page, WITH_DB);
    expect(html).not.toMatch(/<form[^>]*\shidden=""/);
    expect(html).not.toContain(SESSION_COPY.checking);
  });

  it("locks the form and shows a loading message while config is unknown", async () => {
    const html = await render(page, null);
    expect(formIsLocked(html)).toBe(true);
    expect(html).toContain(ACCOUNTS_COPY.loading);
  });

  it("locks the form and shows plain copy when accounts are unavailable", async () => {
    const html = await render(page, NO_DB);
    expect(formIsLocked(html)).toBe(true);
    expect(html).toContain(ACCOUNTS_COPY.unavailable[page].replace("'", "&#x27;"));
    expect(html).not.toMatch(/DATABASE_URL|DEMO_MODE|—/);
    expect(html).not.toContain("Open the demo");
  });

  it("locks the form and offers a retry when the config call failed", async () => {
    const html = await render(page, WITH_DB, true);
    expect(formIsLocked(html)).toBe(true);
    expect(html).toContain(ACCOUNTS_COPY.error.replace("'", "&#x27;"));
    expect(html).toContain(ACCOUNTS_COPY.retry);
    expect(html).not.toMatch(/DATABASE_URL|DEMO_MODE|—/);
  });

  it("leaves the form enabled when accounts are ready", async () => {
    const html = await render(page, WITH_DB);
    expect(formIsLocked(html)).toBe(false);
    expect(html).not.toContain(ACCOUNTS_COPY.loading);
  });
});

describe("sign-out", () => {
  it("clears client state, notifies the server and replaces the route with /login", () => {
    const calls: string[] = [];
    const replace = vi.fn((p: string) => calls.push(`replace:${p}`));
    performLogout({
      clearSession: () => calls.push("clear"),
      notifyServer: () => (calls.push("notify"), Promise.resolve()),
      replace,
    });
    expect(calls).toEqual(["clear", "notify", "replace:/login"]);
    expect(replace).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("still redirects when the server call fails", async () => {
    const replace = vi.fn();
    performLogout({ clearSession: vi.fn(), notifyServer: () => Promise.reject(new Error("offline")), replace });
    await Promise.resolve();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("hides private pages, including browser-stored debriefs, once signed out", () => {
    expect(canViewPrivate({ isAuthenticated: false, demoMode: false })).toBe(false);
    expect(canViewPrivate({ isAuthenticated: true, demoMode: false })).toBe(true);
    expect(canViewPrivate({ isAuthenticated: false, demoMode: true })).toBe(true);
  });
});
