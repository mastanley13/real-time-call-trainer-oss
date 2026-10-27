import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The guard resolves hostnames with dns.promises.lookup; mock it so no test touches the network.
const { lookup, serve, connects } = vi.hoisted(() => ({
  lookup: vi.fn(),
  /** Plays the web server: gets the URL and request options, returns a Response to send back. */
  serve: vi.fn<(url: string, opts: Record<string, unknown>) => Promise<Response>>(),
  /** Every address a fake socket connected to. */
  connects: [] as string[],
}));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const promises = { ...actual.promises, lookup };
  return { ...actual, promises, default: { ...actual, promises } };
});

/**
 * Stand-in for http.request/https.request. Like net.connect, it resolves the host through
 * the lookup hook it was given and only "connects" to an address that hook returned.
 */
function fakeRequest(url: URL, opts: { lookup?: LookupFunction; signal?: AbortSignal }, onResponse: (res: IncomingMessage) => void) {
  const req = Object.assign(new EventEmitter(), {
    destroy: (e?: Error) => { if (e) req.emit("error", e); },
    end: () => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const connect = (address: string) => {
        connects.push(address);
        serve(url.toString(), opts as Record<string, unknown>)
          .then(async (r) => {
            const bytes = r.body ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
            const res = Object.assign(Readable.from(bytes.length ? [bytes] : []), { statusCode: r.status, headers: Object.fromEntries(r.headers) });
            onResponse(res as unknown as IncomingMessage);
          })
          .catch((e: Error) => req.emit("error", e));
      };
      if (isIP(host)) return connect(host);
      if (!opts.lookup) return req.emit("error", new Error("no lookup hook: the connection is not pinned"));
      opts.lookup(host, { all: true }, (err, addrs) => {
        if (err) return req.emit("error", err);
        connect((addrs as { address: string }[])[0].address);
      });
    },
  });
  return req;
}
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return { ...actual, request: fakeRequest, default: { ...actual, request: fakeRequest } };
});
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: fakeRequest, default: { ...actual, request: fakeRequest } };
});

import { FetchPageError, fetchPublicPage, htmlToText, isBlockedIp } from "@/lib/safeFetch";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers as Record<string, string>) } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const requestedUrls = () => serve.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue(PUBLIC);
  connects.length = 0;
  serve.mockReset();
  serve.mockImplementation(async () => html("<html><head><title>Example</title></head><body><p>Hello there.</p></body></html>"));
});

describe("isBlockedIp", () => {
  it.each([
    ["0.0.0.0", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["10.1.2.3", "private 10/8"],
    ["172.16.0.1", "private 172.16/12 start"],
    ["172.31.255.255", "private 172.16/12 end"],
    ["192.168.1.1", "private 192.168/16"],
    ["169.254.169.254", "link-local cloud metadata"],
    ["100.64.0.1", "CGNAT start"],
    ["100.100.100.200", "CGNAT Alibaba metadata"],
    ["192.0.2.10", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["::", "IPv6 unspecified"],
    ["::1", "IPv6 loopback"],
    ["fd00:ec2::254", "IPv6 ULA (AWS metadata)"],
    ["fc00::1", "IPv6 ULA"],
    ["fe80::1", "IPv6 link-local"],
    ["fe80::1%eth0", "IPv6 link-local with zone"],
    ["fec0::1", "IPv6 site-local"],
    ["ff02::1", "IPv6 multicast"],
    ["2001:db8::1", "IPv6 documentation"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::127.0.0.1", "IPv4-compatible loopback"],
    ["64:ff9b::a00:1", "NAT64 of a private address"],
    ["2002:7f00:1::", "6to4 of loopback"],
    ["not-an-ip", "not an IP"],
    ["", "empty"],
    ["1.2.3", "short IPv4"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["93.184.216.34"],
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["11.0.0.1"],
    ["100.128.0.1"],
    ["172.32.0.1"],
    ["192.169.0.1"],
    ["2606:4700:4700::1111"],
    ["::ffff:8.8.8.8"],
    ["64:ff9b::808:808"],
    ["2002:808:808::"],
  ])("allows public address %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("fetchPublicPage URL guard", () => {
  it.each([
    ["localhost", "http://localhost/"],
    ["localhost, upper case", "http://LOCALHOST/"],
    ["localhost with a trailing dot", "http://localhost./"],
    [".localhost subdomain", "http://app.localhost/"],
    [".local host", "http://printer.local/"],
    [".internal host", "http://metadata.google.internal/"],
    ["single-label host", "http://intranet/"],
    ["IPv4 loopback", "http://127.0.0.1/"],
    ["private IPv4", "https://192.168.1.1/admin"],
    ["private 10/8", "http://10.0.0.5/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["CGNAT", "http://100.100.100.200/"],
    ["multicast", "http://224.0.0.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 ULA", "http://[fd00:ec2::254]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/"],
    ["hex IPv4", "http://0x7f000001/"],
    ["decimal IPv4", "http://2130706433/"],
    ["octal IPv4", "http://0177.0.0.1/"],
    ["shortened IPv4", "http://127.1/"],
    ["non-default http port", "http://example.com:8080/"],
    ["non-default https port", "https://example.com:80/"],
    ["ftp scheme", "ftp://example.com/"],
    ["gopher scheme", "gopher://example.com/"],
    ["file scheme", "file:///etc/passwd"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded credentials", "http://user:pw@example.com/"],
    ["embedded username", "http://user@example.com/"],
    ["not a URL", "http://"],
  ])("rejects %s before any DNS lookup or request (%s)", async (_label, url) => {
    const err = await fetchPublicPage(url).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FetchPageError);
    expect((err as Error).message).not.toMatch(/couldn't reach|too long/);
    expect(lookup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    ["a private address", [{ address: "10.0.0.7", family: 4 }]],
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["IPv6 loopback", [{ address: "::1", family: 6 }]],
    ["one public and one private address", [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.10", family: 4 }]],
    ["no addresses", []],
  ])("rejects a hostname that resolves to %s", async (_label, addrs) => {
    lookup.mockResolvedValue(addrs);
    await expect(fetchPublicPage("https://rebind.example.com/")).rejects.toThrow("That address isn't allowed.");
    expect(serve).not.toHaveBeenCalled();
  });

  it("explains a DNS failure without a raw error", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" }));
    const err = await fetchPublicPage("https://nope.example/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchPageError);
    expect((err as Error).message).not.toMatch(/ENOTFOUND|getaddrinfo/);
  });

  it("fetches a public host and returns its readable text", async () => {
    const page = await fetchPublicPage("https://example.com/pricing#plans");
    expect(lookup).toHaveBeenCalledWith("example.com", expect.objectContaining({ all: true }));
    expect(serve).toHaveBeenCalledTimes(1);
    expect(serve.mock.calls[0][1]).toMatchObject({ method: "GET", agent: false, lookup: expect.any(Function) });
    expect(requestedUrls()).toEqual(["https://example.com/pricing"]);
    expect(connects).toEqual(["93.184.216.34"]);
    expect(page).toMatchObject({ url: "https://example.com/pricing", title: "Example", text: "Hello there." });
    expect(page.bytes).toBeGreaterThan(0);
  });

  it("assumes https for a bare hostname", async () => {
    await fetchPublicPage("example.com");
    expect(requestedUrls()).toEqual(["https://example.com/"]);
  });

  it("refuses to connect when DNS rebinds to an internal address after the check", async () => {
    // First answer passes the up-front check; the connection's own lookup then gets loopback.
    lookup.mockResolvedValueOnce(PUBLIC).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchPublicPage("https://rebind.example.com/latest/meta-data/")).rejects.toThrow("That address isn't allowed.");
    expect(connects).toEqual([]);
    expect(serve).not.toHaveBeenCalled();
  });

  it("refuses to connect when the rebinding answer is cloud metadata", async () => {
    lookup.mockResolvedValueOnce(PUBLIC).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(fetchPublicPage("http://rebind.example.com/")).rejects.toThrow("That address isn't allowed.");
    expect(connects).toEqual([]);
  });

  it("re-checks every redirect hop and refuses one that points inside the network", async () => {
    serve.mockImplementationOnce(async () => redirect("http://127.0.0.1/admin"));
    await expect(fetchPublicPage("https://example.com/")).rejects.toThrow("That address isn't allowed.");
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a hostname that resolves to a private address", async () => {
    serve.mockImplementationOnce(async () => redirect("https://internal-dns.example.net/"));
    lookup.mockImplementation(async (host: string) => (host === "internal-dns.example.net" ? [{ address: "10.0.0.2", family: 4 }] : PUBLIC));
    await expect(fetchPublicPage("https://example.com/")).rejects.toThrow("That address isn't allowed.");
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public page", async () => {
    serve.mockImplementationOnce(async () => redirect("/landing"));
    const page = await fetchPublicPage("https://example.com/");
    expect(requestedUrls()).toEqual(["https://example.com/", "https://example.com/landing"]);
    expect(page.url).toBe("https://example.com/landing");
  });

  it("stops after too many redirects", async () => {
    serve.mockImplementation(async () => redirect("/again"));
    await expect(fetchPublicPage("https://example.com/")).rejects.toBeInstanceOf(FetchPageError);
    expect(serve.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("refuses content that is not HTML or plain text", async () => {
    serve.mockImplementationOnce(async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }));
    await expect(fetchPublicPage("https://example.com/file.pdf")).rejects.toBeInstanceOf(FetchPageError);
  });

  it("reads a gzip-compressed page", async () => {
    const body = gzipSync("<html><head><title>Zipped</title></head><body><p>Small and squeezed.</p></body></html>");
    serve.mockImplementationOnce(async () => new Response(body, { status: 200, headers: { "content-type": "text/html", "content-encoding": "gzip" } }));
    await expect(fetchPublicPage("https://example.com/")).resolves.toMatchObject({ title: "Zipped", text: "Small and squeezed." });
  });

  it("hides network errors behind a friendly message", async () => {
    serve.mockImplementationOnce(async () => {
      throw new TypeError("connect ECONNRESET 93.184.216.34:443");
    });
    const err = await fetchPublicPage("https://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchPageError);
    expect((err as Error).message).not.toMatch(/ECONNRESET|93\.184/);
  });
});

describe("htmlToText", () => {
  it("keeps the title and visible text only", () => {
    const page = htmlToText(
      `<html><head><title>Acme &amp; Co &ndash; Freight</title><style>p{}</style><script>var x="<p>no</p>";</script></head><body><nav>Home</nav><h1>Load&nbsp;matching</h1><p>Cut empty miles &#8212; fast.</p><svg><text>icon</text></svg><noscript>enable js</noscript><!-- hidden --></body></html>`,
    );
    expect(page).toEqual({ title: "Acme & Co – Freight", text: "Home\nLoad matching\nCut empty miles — fast." });
  });

  it("returns empty strings for a page with no text", () => {
    expect(htmlToText("<html><head><script>1</script></head><body></body></html>")).toEqual({ title: "", text: "" });
  });

  it("ignores tags that only start with title and strips markup inside the title", () => {
    expect(htmlToText("<titles>no</titles><TITLE lang=en>Hi <b>there</b></TITLE><p>Body</p>").title).toBe("Hi there");
  });

  // Regression: [^>]* tag patterns backtracked quadratically, so 1 MB of unclosed tags blocked the event loop for minutes.
  it.each([
    ["unclosed <p", "<p".repeat(500_000)],
    ["unclosed <a", "<a".repeat(500_000)],
    ["unclosed <br", "<br".repeat(333_333)],
    ["unclosed <td", "<td".repeat(333_333)],
    ["repeated open titles", "<title>x".repeat(125_000)],
    ["unclosed tags before a stray >", `${"<a".repeat(499_999)}<>`],
  ])("handles 1 MB of %s in linear time", (_label, payload) => {
    const t0 = performance.now();
    htmlToText(payload);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
