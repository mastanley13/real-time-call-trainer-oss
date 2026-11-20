import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inviteLink } from "@/components/team/InvitePanel";

describe("inviteLink", () => {
  it("builds the join link with the team code", () => {
    expect(inviteLink("https://calltrainer.tech", "123456")).toBe("https://calltrainer.tech/register?code=123456");
    expect(inviteLink("https://calltrainer.tech/", "482")).toBe("https://calltrainer.tech/register?code=482");
  });
  it("refuses anything that is not a team code", () => {
    expect(inviteLink("https://calltrainer.tech", "12")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "12345678901")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "1234&x=1")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "123456?x=1")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "123456/../login")).toBeNull();
  });
});

describe("invite panel placement", () => {
  it("is on the real Team page only, not the sample or local-demo team", () => {
    const page = readFileSync("src/app/team/page.tsx", "utf8");
    expect(page).toContain("{!data.sample && !local && <InvitePanel />}");
    expect(page).not.toContain("{data.sample && <InvitePanel />}");
    expect(page).not.toContain("{local && <InvitePanel />}");
  });

  it("reads the standing org code from /api/me for any member, and does not mint a separate admin-only token", () => {
    const panel = readFileSync("src/components/team/InvitePanel.tsx", "utf8");
    expect(panel).toContain('fetch("/api/me")');
    expect(panel).toContain("body?.organization?.code");
    expect(panel).not.toMatch(/role\s*===\s*["']owner["']/);
    expect(panel).not.toMatch(/\/api\/team\/invite/);
  });
});
