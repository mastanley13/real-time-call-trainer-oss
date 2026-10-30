import { describe, expect, it } from "vitest";
import { canCoachMember, canSeeMember, checkMemberChange, MemberChangeSchema, membersInScope, teamAssignmentReaches, type ScopeActor, type ScopeMember } from "@/lib/teamScope";

const owner: ScopeActor = { id: "own", role: "owner", isPlatformAdmin: false, organizationId: "o-1" };
const mia: ScopeActor = { id: "mia", role: "manager", isPlatformAdmin: false, organizationId: "o-1" };
const leo: ScopeActor = { id: "leo", role: "manager", isPlatformAdmin: false, organizationId: "o-1" };
const admin: ScopeActor = { id: "adm", role: "trainee", isPlatformAdmin: true, organizationId: null };
const m = (id: string, role: string, managerId: string | null, organizationId = "o-1"): ScopeMember => ({ id, role, managerId, organizationId });

const ravi = m("ravi", "trainee", "mia");
const ana = m("ana", "trainee", "leo");
const new1 = m("new1", "trainee", null);
const outsider = m("x", "trainee", "mia", "o-2");

describe("canSeeMember / canCoachMember", () => {
  it("lets a manager see only their own reps", () => {
    expect(canSeeMember(mia, ravi)).toBe(true);
    expect(canSeeMember(mia, ana)).toBe(false);
    expect(canSeeMember(mia, new1)).toBe(false);
    expect(canSeeMember(mia, outsider)).toBe(false);
  });
  it("lets owners see their whole org and platform admins anyone", () => {
    expect([ravi, ana, new1].every((t) => canSeeMember(owner, t))).toBe(true);
    expect(canSeeMember(owner, outsider)).toBe(false);
    expect(canSeeMember(admin, outsider)).toBe(true);
  });
  it("lets everyone see themselves, but reps can't coach", () => {
    const rep: ScopeActor = { id: "ravi", role: "trainee", isPlatformAdmin: false, organizationId: "o-1" };
    expect(canSeeMember(rep, ravi)).toBe(true);
    expect(canCoachMember(rep, ravi)).toBe(false);
    expect(canSeeMember(rep, ana)).toBe(false);
    expect(canCoachMember(mia, ravi)).toBe(true);
  });
});

describe("membersInScope", () => {
  const all = [m("own", "owner", null), m("mia", "manager", null), m("leo", "manager", null), ravi, ana, new1];
  it("gives a manager themselves and their reps", () => {
    expect(membersInScope(mia, all).map((x) => x.id)).toEqual(["mia", "ravi"]);
  });
  it("gives owners everyone, or one manager's team with a filter", () => {
    expect(membersInScope(owner, all)).toHaveLength(6);
    expect(membersInScope(owner, all, "leo").map((x) => x.id)).toEqual(["leo", "ana"]);
  });
  it("ignores a manager filter from a manager", () => {
    expect(membersInScope(mia, all, "leo").map((x) => x.id)).toEqual(["mia", "ravi"]);
  });
});

describe("checkMemberChange", () => {
  const leoRow = m("leo", "manager", null);
  const ownRow = m("own", "owner", null);
  it("lets owners promote reps and move them between managers", () => {
    expect(checkMemberChange(owner, ravi, { role: "manager" }, null).ok).toBe(true);
    expect(checkMemberChange(owner, ravi, { managerId: "leo" }, leoRow).ok).toBe(true);
    expect(checkMemberChange(owner, ravi, { managerId: null }, null).ok).toBe(true);
  });
  it("keeps managers from reporting to managers", () => {
    const r = checkMemberChange(owner, m("mia", "manager", null), { managerId: "leo" }, leoRow);
    expect(r.ok).toBe(false);
    expect(checkMemberChange(owner, m("mia", "manager", null), { managerId: "own" }, ownRow).ok).toBe(true);
  });
  it("lets a manager claim an unassigned rep and release their own", () => {
    expect(checkMemberChange(mia, new1, { managerId: "mia" }, m("mia", "manager", null)).ok).toBe(true);
    expect(checkMemberChange(mia, ravi, { managerId: null }, null).ok).toBe(true);
  });
  it("stops a manager from taking another manager's rep, changing roles, or placing reps elsewhere", () => {
    expect(checkMemberChange(mia, ana, { managerId: "mia" }, m("mia", "manager", null))).toMatchObject({ ok: false, status: 403 });
    expect(checkMemberChange(mia, ana, { managerId: null }, null)).toMatchObject({ ok: false, status: 403 });
    expect(checkMemberChange(mia, new1, { role: "manager" }, null)).toMatchObject({ ok: false, status: 403 });
    expect(checkMemberChange(mia, new1, { managerId: "leo" }, leoRow)).toMatchObject({ ok: false, status: 403 });
  });
  it("never touches owners, yourself, or other orgs", () => {
    expect(checkMemberChange(owner, ownRow, { role: "trainee" }, null).ok).toBe(false);
    expect(checkMemberChange(owner, m("own2", "owner", null), { managerId: "leo" }, leoRow).ok).toBe(false);
    expect(checkMemberChange(mia, m("mia", "manager", null), { managerId: null }, null).ok).toBe(false);
    expect(checkMemberChange(owner, outsider, { managerId: null }, null)).toMatchObject({ ok: false, status: 400 });
    expect(checkMemberChange(owner, ravi, { managerId: "x" }, m("x", "manager", null, "o-2"))).toMatchObject({ ok: false, status: 400 });
    expect(checkMemberChange(owner, ravi, { managerId: "ravi" }, ravi)).toMatchObject({ ok: false, status: 400 });
    expect(checkMemberChange(owner, ravi, { managerId: "ana" }, ana)).toMatchObject({ ok: false, status: 400 });
  });
  it("needs at least one field", () => {
    expect(MemberChangeSchema.safeParse({}).success).toBe(false);
    expect(MemberChangeSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(MemberChangeSchema.safeParse({ managerId: null }).success).toBe(true);
  });
});

describe("teamAssignmentReaches", () => {
  it("sends an owner's team assignment to everyone and a manager's to their reps", () => {
    expect(teamAssignmentReaches(null, ana)).toBe(true);
    expect(teamAssignmentReaches("mia", ravi)).toBe(true);
    expect(teamAssignmentReaches("mia", ana)).toBe(false);
  });
});
