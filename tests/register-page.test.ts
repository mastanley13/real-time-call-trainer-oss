import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { capabilities: null as unknown, isAuthenticated: false, register: vi.fn() }, query: "plan=pro&interval=year&src=pricing" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

import RegisterPage from "@/app/register/page";

const html = () => renderToStaticMarkup(createElement(RegisterPage));
const submitButton = (h: string) => /<button[^>]*type="submit"[^>]*>/.exec(h)?.[0] ?? "";
const submitDisabled = (h: string) => /\sdisabled=""/.test(submitButton(h));
/** Visible text, with the entities React escapes in text (for example ' as &#x27;) decoded. */
const textOf = (h: string) =>
  h.replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** The opening tag of the element with this id. */
const tagWithId = (h: string, id: string) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(h)?.[0] ?? "";

beforeEach(() => {
  mocks.auth = { capabilities: null, isAuthenticated: false, register: vi.fn() };
  mocks.query = "plan=pro&interval=year&src=pricing";
});

describe("register page plan summary", () => {
  it("shows Pro yearly with the yearly price", () => {
    const h = html();
    expect(h).toContain("Pro, Annual");
    expect(h).toContain("$290/yr");
  });

  it("shows Team monthly differently, with the seat minimum", () => {
    mocks.query = "plan=team&interval=month";
    const h = html();
    expect(h).toContain("Team, Monthly");
    expect(h).toContain("$59/seat/mo");
    expect(h).toContain("3 seats minimum");
  });

  it("shows no summary without a valid plan", () => {
    for (const q of ["", "plan=gold&interval=weekly", "interval=year"]) {
      mocks.query = q;
      expect(html()).not.toContain("Your plan");
    }
  });
});

describe("register page before /api/config answers", () => {
  it("disables Create account until the billing state is known", () => {
    expect(submitDisabled(html())).toBe(true);
  });

  it("stays enabled when /api/config answered with an error (access gate, no cookie), so sign-up is not blocked", () => {
    mocks.auth = { ...mocks.auth, capabilities: null, capabilitiesFailed: true } as typeof mocks.auth;
    expect(submitDisabled(html())).toBe(false);
  });

  it("enables it once capabilities are loaded, billing on or off", () => {
    for (const billing of [true, false]) {
      mocks.auth = { ...mocks.auth, capabilities: { billing, database: true, demoMode: false } };
      expect(submitDisabled(html())).toBe(false);
    }
  });

  it("shows no pending spinner or busy state before a request starts", () => {
    mocks.auth = { ...mocks.auth, capabilities: { billing: false, database: true, demoMode: false } };
    const h = html();
    expect(submitButton(h)).not.toContain("aria-disabled");
    expect(textOf(h)).toContain("Create account");
    expect(h).not.toContain("animate-spin");
    expect(textOf(h)).not.toContain("Creating account");
  });
});

describe("register page, Account first", () => {
  beforeEach(() => {
    mocks.query = "";
    mocks.auth = { ...mocks.auth, capabilities: { billing: false, database: true, demoMode: false } };
  });

  it("has one h1 with the headline", () => {
    const h1s: string[] = html().match(/<h1[^>]*>.*?<\/h1>/g) ?? [];
    expect(h1s).toHaveLength(1);
    expect(textOf(h1s[0] ?? "").trim()).toBe("Create your account. Start practicing.");
  });

  it("states the Free plan from the pricing constants and the password minimum before typing", async () => {
    const { FREE_VOICE_MIN } = await import("@/lib/pricing");
    const { FREE_SIGNUP_LINE, PASSWORD_MIN } = await import("@/lib/registerForm");
    expect(FREE_VOICE_MIN).toBe(10);
    expect(FREE_SIGNUP_LINE).toBe("Free includes ten voice minutes monthly and unlimited text. No card needed.");
    expect(PASSWORD_MIN).toBe(10);
    const t = textOf(html());
    expect(t).toContain(FREE_SIGNUP_LINE);
    expect(t).toContain("At least 10 characters.");
  });

  it("labels every field, wires help text and uses the right autocomplete", () => {
    const h = html();
    const fields: [string, string, string | null][] = [
      ["reg-first-name", "First name", "given-name"],
      ["reg-last-name", "Last name", "family-name"],
      ["reg-email", "Email", "email"],
      ["reg-password", "Password", "new-password"],
      ["reg-team-name", "Team name", "organization"],
    ];
    for (const [id, label, ac] of fields) {
      expect(h).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${label}</label>`));
      const tag = tagWithId(h, id);
      // Static markup in this test setup keeps the React prop casing (autoComplete); HTML attribute names are
      // case-insensitive, so the browser reads it as autocomplete either way.
      expect(tag, id).toMatch(new RegExp(`\\sautocomplete="${ac}"`, "i"));
      const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1] ?? "";
      expect(describedBy, id).not.toBe("");
      for (const helpId of describedBy.split(" ")) expect(tagWithId(h, helpId), helpId).not.toBe("");
      expect(tag, id).toContain('required=""');
      expect(tag, id).not.toContain("aria-invalid");
    }
    expect(tagWithId(h, "reg-email")).toContain('type="email"');
    expect(tagWithId(h, "reg-password")).toContain('type="password"');
    // Paste is allowed: nothing blocks clipboard events anywhere on the page.
    expect(readFileSync("src/app/register/page.tsx", "utf8")).not.toMatch(/onPaste|onCopy|onCut/);
  });

  it("puts first and last name side by side on desktop only", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toContain('className="grid gap-5 lg:grid-cols-2 lg:gap-4"');
    expect(src).not.toMatch(/(?<![a-z]:)grid-cols-2/);
  });

  it("offers create or join as a native radio group and shows only the relevant field", () => {
    const h = html();
    const fieldset = h.slice(h.indexOf("<fieldset"), h.indexOf("</fieldset>"));
    expect(fieldset).toContain("<legend");
    expect(textOf(fieldset)).toContain("Practice workspace");
    const radios = fieldset.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).toContain('name="workspace"');
    expect(radios.find((r) => r.includes('value="create"'))).toContain('checked=""');
    expect(radios.find((r) => r.includes('value="join"'))).not.toContain("checked");
    // Labels for both options, and the solo and invite-code explanations, before any field is filled.
    expect(fieldset).toMatch(/<label[^>]*for="reg-workspace-create"[^>]*>Start a new team<\/label>/);
    expect(fieldset).toMatch(/<label[^>]*for="reg-workspace-join"[^>]*>Join a team with a code<\/label>/);
    expect(textOf(fieldset)).toContain("where your practice is stored");
    expect(textOf(fieldset)).toContain("needs its team code");
    // Only the create field is rendered in create mode.
    expect(tagWithId(h, "reg-team-name")).not.toBe("");
    expect(tagWithId(h, "reg-team-code")).toBe("");
    // The no-button toggle is gone.
    expect(h).not.toContain("aria-pressed");
    // Enabled while idle; locked while a request runs, so a failure cannot land on a field the rep just hid.
    for (const r of radios) expect(r).not.toMatch(/\sdisabled=/);
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toMatch(/onChange=\{\(\) => switchMode\(o\.value\)\}\s*disabled=\{busy\}/);
    expect(src).toMatch(/function switchMode\(m: WorkspaceMode\) \{[^}]*if \(busy\) return;/);
  });

  it("explains the team code before the form fields", () => {
    const h = html();
    expect(h.indexOf("join one with the team code")).toBeGreaterThan(-1);
    expect(h.indexOf("join one with the team code")).toBeLessThan(h.indexOf('id="reg-first-name"'));
  });

  it("keeps Continue with Google as the shared button and labels the primary action Create account", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toContain("<GoogleButton carryIntent />");
    expect(src).not.toMatch(/apple|microsoft|github.*sign|linkedin/i);
    const button = /<button[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/.exec(html())?.[1] ?? "";
    expect(textOf(button).trim()).toBe("Create account");
  });

  it("shows a plain Google failure message in the error summary", async () => {
    const { GOOGLE_ERRORS } = await import("@/components/GoogleButton");
    for (const [code, expected] of [["google_failed", GOOGLE_ERRORS.google_failed], ["google_cancelled", GOOGLE_ERRORS.google_cancelled], ["something_else", GOOGLE_ERRORS.google_failed], ["__proto__", GOOGLE_ERRORS.google_failed], ["toString", GOOGLE_ERRORS.google_failed]]) {
      mocks.query = `error=${code}`;
      const h = html();
      expect(h).toContain('id="reg-summary-h"');
      expect(/<div[^>]*aria-labelledby="reg-summary-h"[^>]*>/.exec(h)?.[0]).toContain('role="alert"');
      expect(textOf(h)).toContain(expected);
      // The raw code is never shown.
      expect(textOf(h)).not.toContain(code);
    }
    mocks.query = "";
    expect(html()).not.toContain('id="reg-summary-h"');
  });

  it("explains the access code up front when /api/config was refused", () => {
    mocks.auth = { ...mocks.auth, capabilities: null, capabilitiesFailed: true } as typeof mocks.auth;
    const h = html();
    expect(textOf(h)).toContain("may be invite-only");
    expect(h).toContain('href="/access?next=%2Fregister"');
  });

  it("shows no env names when accounts are not set up", () => {
    mocks.auth = { ...mocks.auth, capabilities: { billing: false, database: false, demoMode: false } };
    const h = html();
    expect(textOf(h)).toContain("Sign-up is not available on this server yet");
    expect(h).not.toMatch(/DATABASE_URL|DEMO_MODE|\bLLM_[A-Z_]+|\bOPENAI_[A-Z_]+|\bELEVENLABS_[A-Z_]+/);
  });

  it("puts the example preview after the form, labelled as an example, with no score or metric", () => {
    const h = html();
    const formEnd = h.indexOf("</form>");
    const aside = h.slice(h.indexOf("<aside"), h.indexOf("</aside>"));
    expect(formEnd).toBeGreaterThan(-1);
    expect(h.indexOf("<aside")).toBeGreaterThan(formEnd);
    expect(textOf(aside)).toContain("Example session");
    expect(aside).toContain('aria-label="Example transcript"');
    expect(textOf(aside)).not.toMatch(/\d+\s*\/\s*100|%|\bscore\b/i);
    expect(aside).not.toMatch(/<img|<svg/);
  });

  it("never asks for the microphone and uses no sparkle icons, emoji, gradients or remote fonts", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8") + readFileSync("src/lib/registerForm.ts", "utf8");
    expect(src).not.toMatch(/getUserMedia|mediaDevices|AudioContext|RealtimeVoiceSession|Briefing/);
    // The only icon is the pending spinner.
    const icons = [...src.matchAll(/import \{([^}]*)\} from "lucide-react"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
    expect(icons).toEqual(["Loader2"]);
    expect(src).not.toMatch(/gradient|fonts\.googleapis|next\/font/);
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(\d|\b(?:slate|gray|red|teal|emerald|zinc|neutral)-\d/);
    expect(src).not.toMatch(/[–—]/);
    const h = html();
    expect(h).not.toMatch(/gradient/);
    expect(textOf(h)).toContain("only when you start a voice call");
  });
});
