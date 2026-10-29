import "server-only";
import { promises as dns } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { FetchedPage } from "./wizard-types";

/**
 * SSRF-safe fetch of a public web page for the persona wizard ("Product page" tab).
 *
 * Only http/https on default ports, no credentials in the URL, no internal
 * hostnames, and every address the hostname resolves to must be public. Redirects
 * are followed by hand and each hop is re-validated. The body is streamed and
 * capped, and only text/html or text/plain is accepted.
 *
 * DNS rebinding: the request goes through node:http(s) with a `lookup` hook that
 * resolves the hostname itself and refuses the connection if any address is
 * non-public, so the socket only ever connects to an address that was checked. A
 * second DNS answer can't swap in 169.254.169.254. TLS SNI and certificate checks
 * still use the hostname.
 */

/** Errors whose message is safe and friendly to show to the user as-is. */
export class FetchPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchPageError";
  }
}

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT_CHARS = 8_000;
const NOT_ALLOWED = "That address isn't allowed.";

// ---------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this" network / unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

const V4_RANGES = BLOCKED_V4.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base)! & mask) >>> 0, mask };
});

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.net);
}

/** Expands an IPv6 address (optionally with an embedded IPv4 tail) to eight 16-bit groups. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const n = v4ToInt(s.slice(lastColon + 1));
    if (n === null) return null;
    tail.push(n >>> 16, n & 0xffff);
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(8)) return true; // :: unspecified
  if (zeroUpTo(7) && g[7] === 1) return true; // ::1 loopback
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(v4From(g[6], g[7])); // ::ffff:a.b.c.d mapped
  if (zeroUpTo(6)) return isBlockedV4(v4From(g[6], g[7])); // ::a.b.c.d compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedV4(v4From(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(v4From(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (AWS metadata fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard prefix
  return false;
}

/** True when an IP literal is private, loopback, link-local, CGNAT, multicast, reserved, unspecified or metadata. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

/** Validates scheme, port, credentials and hostname shape. Throws FetchPageError. */
function parsePublicUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    const t = raw.trim();
    url = base ? new URL(t, base) : new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new FetchPageError("That doesn't look like a valid web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchPageError("Only http and https links are supported.");
  if (url.username || url.password) throw new FetchPageError(NOT_ALLOWED);
  // URL drops default ports, so any remaining port is non-standard.
  if (url.port) throw new FetchPageError("Only standard web ports (80 and 443) are supported.");
  const host = hostOf(url);
  if (!host) throw new FetchPageError("That doesn't look like a valid web address.");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new FetchPageError(NOT_ALLOWED);
  } else if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new FetchPageError(NOT_ALLOWED);
  }
  url.hash = "";
  return url;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

const NOT_FOUND = "We couldn't find that website. Check the address and try again.";

/** Resolves the hostname and returns its addresses, rejecting it if ANY address is non-public. */
async function publicAddresses(host: string): Promise<{ address: string; family: number }[]> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new FetchPageError(NOT_FOUND);
  }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new FetchPageError(NOT_ALLOWED);
  return addrs;
}

/** Early check with a friendly error before any socket is opened. */
async function assertPublicHost(url: URL): Promise<void> {
  const host = hostOf(url);
  if (isIP(host)) return; // already checked in parsePublicUrl
  await publicAddresses(host);
}

/**
 * Socket lookup hook. The connection resolves the name here, not in the OS resolver
 * behind our back, and only gets addresses that passed isBlockedIp. This is what pins
 * the connection to a checked address even if the DNS answer changed since assertPublicHost.
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  publicAddresses(hostname.replace(/\.$/, "").toLowerCase()).then(
    (addrs) => {
      if (options.all) return callback(null, addrs);
      const pick = (options.family ? addrs.find((a) => a.family === options.family) : undefined) ?? addrs[0];
      callback(null, pick.address, pick.family);
    },
    (e: Error) => callback(e, "", 4),
  );
};

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", cent: "¢", deg: "°", times: "×", laquo: "«", raquo: "»", shy: "",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

const collapse = (s: string) =>
  s
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();

function capText(s: string): string {
  if (s.length <= MAX_TEXT_CHARS) return s;
  const cut = s.slice(0, MAX_TEXT_CHARS);
  const sp = cut.search(/\s\S*$/);
  return (sp > MAX_TEXT_CHARS * 0.8 ? cut.slice(0, sp) : cut).trim();
}

/** Strips a (possibly truncated) element and its contents. */
const dropElement = (html: string, tag: string) => html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, "gi"), " ");

const TITLE_SCAN = 65_536;

/**
 * The <title> text, found with indexOf rather than a regex: a lazy regex rescans to the
 * end of the page at every "<title" with no closing tag, which is quadratic on hostile input.
 */
function titleOf(html: string): string {
  const head = html.slice(0, TITLE_SCAN);
  const lower = head.toLowerCase();
  let at = lower.indexOf("<title");
  while (at >= 0 && /[\w]/.test(lower[at + 6] ?? "")) at = lower.indexOf("<title", at + 6);
  if (at < 0) return "";
  const open = lower.indexOf(">", at);
  const close = open < 0 ? -1 : lower.indexOf("</title", open + 1);
  return close < 0 ? "" : head.slice(open + 1, close);
}

/*
 * Every tag pattern excludes "<" from its attribute run ([^<>]*). With [^>]* each
 * unclosed "<p" scans to the end of the page and fails, so 1 MB of "<p<p<p..." took
 * minutes of blocking CPU. With [^<>]* each attempt stops at the next "<": linear time.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const rawTitle = titleOf(html);
  const title = rawTitle ? collapse(decodeEntities(rawTitle.replace(/<[^<>]*>/g, " "))).replace(/\n/g, " ").slice(0, 300) : "";
  let body = html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  for (const tag of ["head", "script", "style", "noscript", "svg", "template"]) body = dropElement(body, tag);
  body = body
    // Source line breaks are just spaces in HTML; real breaks come from the block tags below.
    .replace(/\s+/g, " ")
    .replace(/<(br|hr)\b[^<>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|dl|dt|dd|tr|table|h[1-6]|blockquote|pre|figure|figcaption|form|label|button)\b[^<>]*>/gi, "\n")
    .replace(/<\/?(td|th)\b[^<>]*>/gi, " ")
    .replace(/<\/?[a-z!][^<>]*>/gi, " ")
    .replace(/<\/?[a-z!][^<>]*$/i, " ");
  return { title, text: capText(collapse(decodeEntities(body))) };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const UNREADABLE = "That link isn't a web page we can read (only HTML or plain text). Paste the text instead.";

/** One GET over node:http(s), connecting only through pinnedLookup. No pooled sockets, no automatic redirects. */
function requestPage(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: "GET",
      signal,
      lookup: pinnedLookup,
      agent: false,
      headers: {
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "RealTimeCallTrainer/1.0 (persona wizard)",
      },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** The decoded body stream. The byte cap applies after decompression, so a zip bomb stops at MAX_BYTES too. */
function bodyStream(res: IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const done = () => undefined;
  if (enc === "gzip" || enc === "x-gzip") return pipeline(res, createGunzip(), done);
  if (enc === "deflate") return pipeline(res, createInflate(), done);
  if (enc === "br") return pipeline(res, createBrotliDecompress(), done);
  if (enc === "identity" || enc === "") return res;
  res.destroy();
  throw new FetchPageError(UNREADABLE);
}

async function readCapped(res: IncomingMessage): Promise<{ bytes: Uint8Array; size: number }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of bodyStream(res)) {
      const value = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Uint8Array);
      const room = MAX_BYTES - size;
      if (value.byteLength >= room) {
        // Past the cap: keep what fits and stop downloading. The text is capped far below this anyway.
        chunks.push(value.subarray(0, room));
        size += room;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    res.destroy();
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { bytes: out, size };
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** Fetches a public page and returns its readable text. Throws FetchPageError with a user-facing message. */
export async function fetchPublicPage(rawUrl: string): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = parsePublicUrl(rawUrl);
  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url);
      const res = await requestPage(url, signal);
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.destroy();
        if (!location) throw new FetchPageError("That page redirected somewhere we couldn't follow.");
        if (hop >= MAX_REDIRECTS) throw new FetchPageError("That page redirects too many times.");
        url = parsePublicUrl(location, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        throw new FetchPageError(
          status === 401 || status === 403
            ? "That page needs a login or blocks automated readers. Paste the text instead."
            : `That page returned an error (HTTP ${status}).`,
        );
      }

      const contentType = String(res.headers["content-type"] ?? "");
      const mime = contentType.split(";")[0].trim().toLowerCase();
      if (mime !== "text/html" && mime !== "text/plain") {
        res.destroy();
        throw new FetchPageError(UNREADABLE);
      }

      const { bytes, size } = await readCapped(res);
      const raw = decodeBody(bytes, contentType);
      const { title, text } = mime === "text/html" ? htmlToText(raw) : { title: "", text: capText(collapse(raw)) };
      if (!text) throw new FetchPageError("We couldn't find any readable text on that page. Paste the text instead.");
      return { url: url.toString(), title: title || hostOf(url), text, bytes: size };
    }
  } catch (e) {
    if (e instanceof FetchPageError) throw e;
    if (isTimeout(e) || signal.aborted) throw new FetchPageError("That page took too long to load.");
    throw new FetchPageError("We couldn't reach that page. Check the address and try again.");
  }
}
