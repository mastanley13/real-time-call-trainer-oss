import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoicePanelView, parseVoiceView, type VoiceView } from "@/components/team/VoicePanel";

// No DOM test setup in this repo, so the panel is rendered to HTML with React's server renderer.
const render = (view: VoiceView | null, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(VoicePanelView, { view, onChoose: () => {}, ...extra }));

const view = (over: Partial<VoiceView> = {}): VoiceView => ({ tier: "standard", selected: "standard", comped: true, canEdit: true, ...over });

describe("VoicePanelView", () => {
  it.each([
    ["a manager or trainee on a comped Standard team", view({ canEdit: false })],
    ["a manager or trainee on a comped Premium team", view({ canEdit: false, tier: "premium", selected: "premium" })],
    ["the owner of a team that is not comped", view({ canEdit: false, comped: false })],
  ])("renders nothing at all for %s (canEdit false): no controls, no read-only state", (_who, v) => {
    const html = render(v);
    expect(html).toBe("");
    expect(html).not.toContain("radio");
    expect(html).not.toContain("Voice quality");
  });

  it("renders nothing before the setting has loaded, or when it failed to load", () => {
    expect(render(null)).toBe("");
  });

  it("renders the Standard and Premium controls, enabled, for an editor (canEdit true)", () => {
    const html = render(view({ tier: "premium", selected: "premium" }));
    expect(html).toContain('role="radiogroup"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(2);
    expect(html).toContain(">Standard<");
    expect(html).toContain(">Premium<");
    expect(html).toMatch(/aria-checked="true"[^>]*>Premium</);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("Only the team owner");
    // Tier names only: no model id.
    expect(html).not.toMatch(/gpt|realtime/i);
  });

  it("shows a platform admin the stored choice on a team that is not comped, with the note that calls use Standard", () => {
    const html = render(view({ canEdit: true, comped: false, tier: "standard", selected: "premium" }));
    expect(html).toMatch(/aria-checked="true"[^>]*>Premium</);
    expect(html).toContain("calls use Standard whatever you pick here");
  });

  it("says which tier the next call runs on after a save: the effective one", () => {
    const html = render(view({ canEdit: true, comped: false, tier: "standard", selected: "premium" }), { saved: true });
    expect(html).toContain("The next voice call uses Standard.");
  });
});

describe("parseVoiceView", () => {
  it("reads the effective tier, and falls back to it as the choice when selected is absent", () => {
    expect(parseVoiceView({ tier: "standard", comped: false, canEdit: false })).toEqual({ tier: "standard", selected: "standard", comped: false, canEdit: false });
    expect(parseVoiceView({ tier: "standard", selected: "premium", comped: false, canEdit: true })).toEqual({ tier: "standard", selected: "premium", comped: false, canEdit: true });
  });

  it("returns null for demo mode and junk", () => {
    expect(parseVoiceView({ tier: "standard", local: true })).toBeNull();
    for (const junk of [null, undefined, "x", 3]) expect(parseVoiceView(junk)).toBeNull();
  });
});
