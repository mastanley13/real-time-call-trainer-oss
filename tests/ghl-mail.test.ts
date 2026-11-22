import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ghlWebhook (imported only to check its timeout is untouched) imports the database client; nothing here touches it.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  GHL_API_VERSION,
  GHL_MAIL_TIMEOUT_MS,
  GHL_MESSAGES_URL,
  GHL_UPSERT_URL,
  ghlContactTagsUrl,
  ghlMailConfigured,
  passwordResetEmail,
  sendMail,
} from "@/lib/ghlMail";
import { GHL_TIMEOUT_MS } from "@/lib/ghlWebhook";

const TOKEN = "pit-test-token-0123456789";
const LOCATION = "loc-test-123";
const FROM = "support@calltrainer.example";
const CONTACT_ID = "contact-abc-987";
const RECIPIENT = "Mia.Chen@Example.test";
const RESET_TOKEN = "v1.dXNlci0x.1800000000000.fp.SIGNATURE-SECRET";
const LINK = `https://calltrainer.example/reset-password?token=${RESET_TOKEN}`;

const ENV = { NODE_ENV: "production", GHL_API_TOKEN: TOKEN, GHL_LOCATION_ID: LOCATION, GHL_RESET_FROM_EMAIL: FROM };
const msg = () => passwordResetEmail(RECIPIENT, LINK);

const upsertOk = () => new Response(JSON.stringify({ new: false, contact: { id: CONTACT_ID, email: "mia.chen@example.test" } }), { status: 200 });
const tagsOk = () => new Response(JSON.stringify({ tags: ["ct-signed-up", "ct-transactional", "app-calltrainer"] }), { status: 201 });
const sendOk = () => new Response(JSON.stringify({ conversationId: "conv-1", messageId: "msg-1" }), { status: 201 });
const TAGS_URL = `https://services.leadconnectorhq.com/contacts/${CONTACT_ID}/tags`;

let fetchMock: ReturnType<typeof vi.fn>;
let spies: Array<ReturnType<typeof vi.spyOn>>;

/** Everything written to the console in this test, as one string. */
const logged = () => spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");

function expectNoSecretsLogged() {
  const text = logged();
  for (const leak of [LINK, RESET_TOKEN, "SIGNATURE-SECRET", "reset-password", RECIPIENT, RECIPIENT.toLowerCase(), TOKEN, CONTACT_ID, LOCATION]) {
    expect(text).not.toContain(leak);
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("passwordResetEmail", () => {
  it("is short and transactional: subject, one link, the 30 minute expiry and the ignore line", () => {
    const m = msg();
    expect(m.to).toBe(RECIPIENT);
    expect(m.subject).toBe("Reset your Call Trainer password");
    for (const body of [m.text, m.html]) {
      expect(body).toContain("30 minutes");
      expect(body).toContain("If you did not ask for this, ignore this email.");
      expect(body).not.toMatch(/—/);
    }
    expect(m.text.match(/https?:\/\//g)).toHaveLength(1);
    expect(m.html.match(/href=/g)).toHaveLength(1);
    expect(m.text).toContain(LINK);
  });

  it("escapes the link in the html body", () => {
    const m = passwordResetEmail(RECIPIENT, 'https://x.example/reset-password?token=a"b<c');
    expect(m.html).toContain("token=a&quot;b&lt;c");
  });
});

describe("ghlMailConfigured", () => {
  it("needs all three of GHL_API_TOKEN, GHL_LOCATION_ID and GHL_RESET_FROM_EMAIL", () => {
    expect(ghlMailConfigured(ENV)).toBe(true);
    expect(ghlMailConfigured({ ...ENV, GHL_API_TOKEN: "" })).toBe(false);
    expect(ghlMailConfigured({ ...ENV, GHL_LOCATION_ID: "  " })).toBe(false);
    expect(ghlMailConfigured({ ...ENV, GHL_RESET_FROM_EMAIL: undefined })).toBe(false);
    expect(ghlMailConfigured({})).toBe(false);
  });

  it("does not treat the lifecycle webhook variables as mail config", () => {
    expect(ghlMailConfigured({ GHL_BILLING_EVENTS: "true", GHL_WEBHOOK_URL: "https://hooks.example/x" })).toBe(false);
  });
});

describe("sendMail through GoHighLevel", () => {
  it("upserts the contact, adds the tags, then sends the email with the right URLs, headers and bodies", async () => {
    fetchMock.mockResolvedValueOnce(upsertOk()).mockResolvedValueOnce(tagsOk()).mockResolvedValueOnce(sendOk());
    expect(await sendMail(msg(), ENV)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [upsertUrl, upsertInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [tagsUrl, tagsInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const [sendUrl, sendInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(upsertUrl).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    expect(upsertUrl).toBe(GHL_UPSERT_URL);
    expect(tagsUrl).toBe(TAGS_URL);
    expect(tagsUrl).toBe(ghlContactTagsUrl(CONTACT_ID));
    expect(sendUrl).toBe("https://services.leadconnectorhq.com/conversations/messages");
    expect(sendUrl).toBe(GHL_MESSAGES_URL);

    for (const init of [upsertInit, tagsInit, sendInit]) {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Authorization: `Bearer ${TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
        "Content-Type": "application/json",
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(GHL_API_VERSION).toBe("2021-07-28");

    // No names, phone or tags in the upsert (an upsert can replace the contact's tags): exactly these fields.
    const upsertBody = JSON.parse(String(upsertInit.body));
    expect(upsertBody).toEqual({ locationId: LOCATION, email: "mia.chen@example.test" });
    expect(upsertBody).not.toHaveProperty("tags");
    // Tags go through the additive tags endpoint instead.
    expect(JSON.parse(String(tagsInit.body))).toEqual({ tags: ["ct-transactional", "app-calltrainer"] });
    const m = msg();
    expect(JSON.parse(String(sendInit.body))).toEqual({
      type: "Email",
      contactId: CONTACT_ID,
      emailFrom: FROM,
      subject: "Reset your Call Trainer password",
      html: m.html,
      message: m.text,
    });
    expectNoSecretsLogged();
  });

  it("puts the 8 second mail timeout on each call, separate from the webhook timeout", async () => {
    expect(GHL_MAIL_TIMEOUT_MS).toBe(8000);
    expect(GHL_TIMEOUT_MS).toBe(2500);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValueOnce(upsertOk()).mockResolvedValueOnce(tagsOk()).mockResolvedValueOnce(sendOk());
    await sendMail(msg(), ENV);
    expect(timeout).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls.every(([ms]) => ms === GHL_MAIL_TIMEOUT_MS)).toBe(true);
  });

  it("encodes the contact id in the tags URL", () => {
    expect(ghlContactTagsUrl("a/b?c")).toBe("https://services.leadconnectorhq.com/contacts/a%2Fb%3Fc/tags");
  });

  it("still sends the email when adding the tags fails, logging only the step and status", async () => {
    fetchMock
      .mockResolvedValueOnce(upsertOk())
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: `no ${CONTACT_ID}` }), { status: 500 }))
      .mockResolvedValueOnce(sendOk());
    expect(await sendMail(msg(), ENV)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(GHL_MESSAGES_URL);
    const error = vi.mocked(console.error);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toBe("[mailer] GHL tags failed with status 500.");
    expectNoSecretsLogged();

    // A tag request that never completes does not block the send either.
    fetchMock.mockResolvedValueOnce(upsertOk()).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError")).mockResolvedValueOnce(sendOk());
    expect(await sendMail(msg(), ENV)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5][0]).toBe(GHL_MESSAGES_URL);
    expect(String(error.mock.calls[1][0])).toBe("[mailer] GHL tags failed: the request did not complete.");
    expectNoSecretsLogged();
  });

  it("does not send and does not throw when the upsert fails, logging only the step and status", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: `bad ${RECIPIENT.toLowerCase()} ${LOCATION}` }), { status: 422 }));
    await expect(sendMail(msg(), ENV)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const error = vi.mocked(console.error);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toBe("[mailer] GHL upsert failed with status 422.");
    expectNoSecretsLogged();
  });

  it("does not send when the upsert answers without a contact id", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ new: true }), { status: 200 }));
    expect(await sendMail(msg(), ENV)).toEqual({ ok: false, reason: "failed" });
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect(await sendMail(msg(), ENV)).toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === GHL_UPSERT_URL)).toBe(true);
    expectNoSecretsLogged();
  });

  it("does not send and does not throw when the upsert times out", async () => {
    // Stand in for the timer so the test does not wait GHL_MAIL_TIMEOUT_MS: the mailer's signal is one we can fire.
    const clock = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    }));
    const done = sendMail(msg(), ENV);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    clock.abort();
    await expect(done).resolves.toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toBe("[mailer] GHL upsert failed: the request did not complete.");
    expectNoSecretsLogged();
  });

  it("does not throw when the upsert request rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`network down for ${TOKEN}`));
    await expect(sendMail(msg(), ENV)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expectNoSecretsLogged();
  });

  it("does not throw and does not retry when the send fails", async () => {
    fetchMock
      .mockResolvedValueOnce(upsertOk())
      .mockResolvedValueOnce(tagsOk())
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: `no ${CONTACT_ID}` }), { status: 400 }));
    await expect(sendMail(msg(), ENV)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toBe("[mailer] GHL send failed with status 400.");
    expectNoSecretsLogged();

    fetchMock.mockResolvedValueOnce(upsertOk()).mockResolvedValueOnce(tagsOk()).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(sendMail(msg(), ENV)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expectNoSecretsLogged();
  });
});

describe("sendMail when GoHighLevel is not configured", () => {
  it("logs one generic warning in production and sends nothing, even with DEMO_MODE=true", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", DEMO_MODE: "true", GHL_API_TOKEN: TOKEN, GHL_LOCATION_ID: LOCATION }]) {
      spies.forEach((s) => s.mockClear());
      expect(await sendMail(msg(), env)).toEqual({ ok: false, reason: "not_configured" });
      const warn = vi.mocked(console.warn);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain("not configured");
      expect(vi.mocked(console.info)).not.toHaveBeenCalled();
      expect(vi.mocked(console.log)).not.toHaveBeenCalled();
      expectNoSecretsLogged();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints the email with the link to the console outside production", async () => {
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "development", DEMO_MODE: "true" }, { NODE_ENV: "test" }]) {
      spies.forEach((s) => s.mockClear());
      expect(await sendMail(msg(), env)).toEqual({ ok: false, reason: "not_configured" });
      const info = vi.mocked(console.info);
      expect(info).toHaveBeenCalledOnce();
      expect(String(info.mock.calls[0][0])).toContain(LINK);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
