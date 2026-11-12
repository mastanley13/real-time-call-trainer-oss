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
  });
});
