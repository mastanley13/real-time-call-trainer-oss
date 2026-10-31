import { describe, expect, it } from "vitest";
import { backfillOrganization, type Org } from "@/lib/userOrg";

type U = { id: string; organization?: Org | null };
const org: Org = { id: "o1", name: "Acme Test", code: "123456" };

describe("backfillOrganization", () => {
  it("fills the team for the same user", () => {
    expect(backfillOrganization<U>({ id: "u1" }, "u1", org)).toEqual({ id: "u1", organization: org });
  });
  it("stores null for a user with no team so the lookup is not repeated", () => {
    expect(backfillOrganization<U>({ id: "u1" }, "u1", null)).toEqual({ id: "u1", organization: null });
  });
  it("ignores a result for a different user (session changed while pending)", () => {
    const cur: U = { id: "u2" };
    expect(backfillOrganization(cur, "u1", org)).toBe(cur);
  });
  it("ignores a result when signed out", () => {
    expect(backfillOrganization<U>(null, "u1", org)).toBeNull();
  });
  it("never overwrites a team already recorded, including null", () => {
    const withOrg: U = { id: "u1", organization: { id: "o2", name: "Other" } };
    const noTeam: U = { id: "u1", organization: null };
    expect(backfillOrganization(withOrg, "u1", org)).toBe(withOrg);
    expect(backfillOrganization(noTeam, "u1", org)).toBe(noTeam);
  });
  it("leaves the user alone when the payload has no organization field", () => {
    const cur: U = { id: "u1" };
    expect(backfillOrganization(cur, "u1", undefined)).toBe(cur);
  });
});
