import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isTokenFresh } from "@/lib/clientSession";

const token = (payload: unknown) => `header.${btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

describe("client session freshness hint", () => {
  it("rechecks a session when an existing trainer tab starts another call", () => {
    const expires = 1_800_000_000;
    const session = token({ exp: expires });
    expect(isTokenFresh(session, (expires - 60) * 1000)).toBe(true);
    expect(isTokenFresh(session, expires * 1000)).toBe(false);
    expect(isTokenFresh(session, (expires + 60) * 1000)).toBe(false);
  });

  it.each([null, "", "not-a-token", "a.!!!.c", token(null), token({}), token({ exp: "1800000000" })])("rejects missing or malformed expiry: %s", (session) => {
    expect(isTokenFresh(session, 1_700_000_000_000)).toBe(false);
  });

  it("only reads expiry; it never claims to verify the signature", () => {
    expect(isTokenFresh(token({ exp: 1_800_000_000, name: "Fictional trainee" }), 1_700_000_000_000)).toBe(true);
  });
});

describe("trainer Start with an expired session", () => {
  const src = readFileSync("src/components/TrainerClient.tsx", "utf8");
  const start = src.indexOf("function begin()");
  const begin = src.slice(start, start + 900);

  it("rechecks the cached token before opening the mic or starting text, and goes to sign in when it is stale", () => {
    expect(start).toBeGreaterThan(0);
    expect(begin).toContain("isTokenFresh(localStorage.getItem(\"authToken\"))");
    expect(begin).toContain("window.location.assign(\"/login\")");
    expect(begin.indexOf("isTokenFresh")).toBeLessThan(begin.indexOf("coach.reset()"));
    expect(begin.indexOf("window.location.assign")).toBeLessThan(begin.indexOf("coach.reset()"));
  });

  it("skips that check in demo mode so local practice still starts without a session", () => {
    expect(begin).toContain("!capabilities?.demoMode");
  });
});
