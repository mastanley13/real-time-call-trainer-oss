import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/access mints the httpOnly trainer_access cookie when TRAINER_ACCESS_CODE is set.
 * The cookie is an HMAC of the code (never the raw code). Wrong codes, a missing gate and
 * invalid bodies must not set it. The route, the HMAC helpers and the proxy gate run for real.
 */
import { POST } from "@/app/api/access/route";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessToken, hasValidAccessCookie } from "@/lib/access";
import { proxy } from "@/proxy";

const CODE = "let-me-in";
const JWT = "test-only-secret-0123456789abcdef";
const OTHER_CODE = "not-the-code";

let n = 0;
const ip = () => `198.18.77.${++n}`;

function post(body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip(),
    ...extra,
  };
  return POST(new NextRequest("http://localhost/api/access", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function cookieValue(header: string): string | undefined {
  return new RegExp(`${ACCESS_COOKIE}=([^;]+)`).exec(header)?.[1];
}

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", JWT);
  vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/access cookie mint", () => {
  it("mints an httpOnly HMAC cookie on the right code, never the raw code", async () => {
    const expected = await accessToken(CODE);
    const res = await post({ code: CODE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const header = setCookie(res);
    expect(header).toContain(`${ACCESS_COOKIE}=`);
    expect(header.toLowerCase()).toContain("httponly");
    expect(header.toLowerCase()).toContain("samesite=lax");
    expect(header.toLowerCase()).toMatch(/path=\//);
    expect(header.toLowerCase()).toContain(`max-age=${ACCESS_MAX_AGE}`);
    expect(header.toLowerCase()).not.toContain("secure");
    const value = cookieValue(header)!;
    expect(value).toBe(expected);
    expect(value).not.toBe(CODE);
    expect(header).not.toContain(CODE);
    const gated = new NextRequest("http://localhost:3000/dashboard", {
      headers: { cookie: `${ACCESS_COOKIE}=${value}` },
    });
    expect(await hasValidAccessCookie(gated, CODE)).toBe(true);
    const through = await proxy(gated);
    expect(through.headers.get("location")).toBeNull();
    expect(through.status).toBe(200);
  });

  it("trims surrounding whitespace on the submitted code", async () => {
    const res = await post({ code: `  ${CODE}  ` });
    expect(res.status).toBe(200);
    expect(cookieValue(setCookie(res))).toBe(await accessToken(CODE));
  });

  it("sets Secure on the cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ code: CODE });
    expect(res.status).toBe(200);
    expect(setCookie(res).toLowerCase()).toContain("secure");
  });

  it("returns 401 and sets no cookie on the wrong code", async () => {
    const res = await post({ code: OTHER_CODE });
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: "That code isn't right." });
    expect(text).not.toContain(CODE);
    expect(setCookie(res)).not.toContain(`${ACCESS_COOKIE}=`);
  });

  it("returns 401 and sets no cookie when the code field is missing or the wrong type", async () => {
    for (const body of [{}, { code: "" }, { code: 12 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(setCookie(res)).not.toContain(`${ACCESS_COOKIE}=`);
    }
  });

  it("returns 400 on invalid JSON and sets no cookie", async () => {
    const res = await post("{", { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(setCookie(res)).not.toContain(`${ACCESS_COOKIE}=`);
  });

  it("returns { ok: true } with no cookie when the gate is unset", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "");
    const res = await post({ code: CODE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCookie(res)).not.toContain(`${ACCESS_COOKIE}=`);
  });

  it("rate limits a single IP after 10 tries", async () => {
    const locked = "198.18.199.10";
    const hit = () =>
      POST(new NextRequest("http://localhost/api/access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": locked },
        body: JSON.stringify({ code: OTHER_CODE }),
      }));
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await hit()).status);
    expect(codes).toEqual(Array(10).fill(401));
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await limited.json()).error).toBe("rate_limited");
    expect(setCookie(limited)).not.toContain(`${ACCESS_COOKIE}=`);
  });
});
