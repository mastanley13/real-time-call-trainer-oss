import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const saved = process.env.TRAINER_ACCESS_CODE;
beforeEach(() => {
  delete process.env.TRAINER_ACCESS_CODE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TRAINER_ACCESS_CODE; else process.env.TRAINER_ACCESS_CODE = saved;
});

const run = (path: string, method = "GET") => middleware(new NextRequest(`http://localhost${path}`, { method }));

describe("site-wide access gate", () => {
  it("lets /register, /login and /api/auth/register through when TRAINER_ACCESS_CODE is unset", async () => {
    for (const [path, method] of [["/register", "GET"], ["/login", "GET"], ["/api/auth/register", "POST"]] as const) {
      const res = await run(path, method);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.status, path).toBe(200);
    }
  });

  it("still gates them for a private beta when the code is set", async () => {
    process.env.TRAINER_ACCESS_CODE = "letmein";
    const page = await run("/register");
    expect(page.headers.get("location")).toContain("/access");
    expect((await run("/api/auth/register", "POST")).status).toBe(401);
  });
});
