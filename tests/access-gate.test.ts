import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const call = (path: string) => middleware(new NextRequest(`http://localhost${path}`));
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

afterEach(() => {
  delete process.env.TRAINER_ACCESS_CODE;
});

describe("access gate allowlist", () => {
  it("lets the home page, privacy and terms through when the code is set", async () => {
    process.env.TRAINER_ACCESS_CODE = "let-me-in";
    for (const path of ["/", "/privacy", "/terms"]) expect(passes(await call(path))).toBe(true);
  });

  it("still gates everything else", async () => {
    process.env.TRAINER_ACCESS_CODE = "let-me-in";
    const page = await call("/dashboard");
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location") ?? "").pathname).toBe("/access");
    expect((await call("/api/sessions")).status).toBe(401);
    expect((await call("/privacy/extra")).status).toBe(307);
  });

  it("gates nothing when the code is unset", async () => {
    for (const path of ["/", "/privacy", "/terms", "/dashboard", "/api/sessions"]) {
      expect(passes(await call(path))).toBe(true);
    }
  });
});
