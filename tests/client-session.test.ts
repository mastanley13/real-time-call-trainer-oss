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
