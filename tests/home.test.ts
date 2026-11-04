import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

describe("landing hero line", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const hero = html.slice(0, html.indexOf("how-h"));

  it("leads with the hosted pitch and the two CTAs", () => {
    expect(hero).toContain("Sales call practice, <span");
    expect(hero.replace(/<[^>]+>/g, "")).toContain("Sales call practice, no setup required");
    expect(hero).toContain("Practice real sales calls against 54 AI buyer personas. No API keys, no database, just sign up and start talking.");
    expect(hrefs(hero)).toEqual(expect.arrayContaining(["/register?src=home_hero", "/pricing"]));
    expect(hero).toContain(">Start free <");
    expect(hero).toContain(">See pricing<");
  });

  it("keeps demo mode and bring your own key out of the hero", () => {
    expect(hero).not.toMatch(/demo mode|DEMO_MODE|bring your own key/i);
    expect(html).not.toContain("DEMO_MODE");
  });

  it("puts the open source message in the self-host section with a setup that has no demo mode", () => {
    const oss = html.slice(html.indexOf("oss-h"));
    expect(oss).toContain("bring your own key");
    expect(oss).toContain("npm run dev");
  });

  it("keeps the model table off the hosted home page and links to the self-hosting docs", () => {
    expect(html).not.toMatch(/Under the hood|Which model does what|LLM_BASE_URL|gpt-4\.1-mini/);
    const oss = html.slice(html.indexOf("oss-h"));
    expect(oss).toContain('href="https://github.com/mastanley13/real-time-call-trainer-oss#which-model-does-what"');
    expect(oss).toContain(">Self-hosting</a>");
  });

  it("leaves one section gap between How it works and the features, not two", () => {
    const sectionClass = (id: string) => html.match(new RegExp(`<section class="([^"]*)" aria-labelledby="${id}"`))?.[1];
    expect(sectionClass("how-h")).toBe("page py-14 sm:py-16");
    // .page sets py-8 sm:py-10 itself, so the features section must zero its top padding explicitly.
    expect(sectionClass("feat-h")).toBe("page pt-0 pb-14 sm:pb-16");
  });

  it(".page still carries its own vertical padding, which pt-0 on the features section has to cancel", () => {
    expect(readFileSync("src/app/globals.css", "utf8")).toMatch(/\.page \{ @apply [^}]*\bpy-8\b[^}]*\bsm:py-10\b/);
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
