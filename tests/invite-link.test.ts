import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inviteLink } from "@/components/team/InvitePanel";

describe("InvitePanel copy", () => {
  it("says Google sign-up starts its own workspace, matching the register page", () => {
    const src = readFileSync("src/components/team/InvitePanel.tsx", "utf8");
    expect(src).toContain("Google sign-up starts its own workspace, so they should use email.");
    expect(src).not.toContain("separate team");
  });
});

describe("inviteLink", () => {
  it("builds the join link with the team code", () => {
    expect(inviteLink("https://calltrainer.tech", "123456")).toBe("https://calltrainer.tech/register?code=123456");
    expect(inviteLink("https://calltrainer.tech/", "482")).toBe("https://calltrainer.tech/register?code=482");
  });
  it("refuses anything that is not a team code", () => {
    expect(inviteLink("https://calltrainer.tech", "12")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "12345678901")).toBeNull();
    expect(inviteLink("https://calltrainer.tech", "1234&x=1")).toBeNull();
  });
});
