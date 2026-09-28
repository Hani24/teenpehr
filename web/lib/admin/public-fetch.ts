import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

/*
 * A GET that can reach only the public internet, for the admin's "test fetch" (an editor types any
 * URL, and the web server makes the request from inside the host's network). Every address a host
 * name resolves to is checked when the socket connects (the `lookup` hook, so a name cannot resolve
 * to a public address for a check and a private one for the connection), an IP literal is checked
 * before, and each redirect is followed by hand through the same checks. The body is read up to a
 * cap and the whole exchange has one deadline.
 *
 * Not public: loopback, private (RFC 1918, ULA), carrier-grade NAT, link-local (cloud metadata),
 * multicast, documentation, benchmarking and reserved ranges, and IPv6 forms that embed an IPv4
 * address (mapped, NAT64, 6to4, Teredo).
 */
const notPublic = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) notPublic.addSubnet(net, prefix, "ipv4");
// No ::ffff:0:0/96 rule: BlockList already checks an IPv4-mapped address against the IPv4 rules, and it
// would check every plain IPv4 address against that rule too, refusing them all.
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) notPublic.addSubnet(net, prefix, "ipv6");

/** Whether an IP address is on the public internet. Anything that is not an IP address is not. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? !notPublic.check(ip, "ipv4") : v === 6 ? !notPublic.check(ip, "ipv6") : false;
}

/**
 * Whether a URL host could be on the public internet, without resolving it: an IP literal must be a
 * public address, and a name must not be one only a local network knows (localhost, a bare label,
 * .local, .internal and the like). The fetchers still check the addresses it resolves to.
 */
export function looksPublicHost(hostname: string): boolean {
  const h = hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (isIP(h)) return isPublicAddress(h);
  if (!h.includes(".")) return false;
  return !/(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|home\.arpa)$/.test(h);
}

export class NotPublicError extends Error {
  constructor() { super("that address is not on the public internet"); this.name = "NotPublicError"; }
}
export class FetchTimeoutError extends Error {
  constructor() { super("timeout"); this.name = "FetchTimeoutError"; }
}

/** dns.lookup that refuses a name when any address it resolves to is not public. */
const publicLookup = ((hostname: string, options: { all?: boolean; family?: number }, callback: (...a: unknown[]) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) return callback(new NotPublicError());
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}) as unknown as LookupFunction;

export type PublicGetResult = {
  status: number; contentType: string; finalUrl: string; body: string; bytes: number; truncated: boolean; redirects: number;
};

const MAX_REDIRECTS = 5;

/** GET `rawUrl` over the public internet only (see above). Throws NotPublicError, FetchTimeoutError or a network error. */
export async function publicGet(rawUrl: string, opts: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }): Promise<PublicGetResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`redirected to a ${url.protocol} URL`);
    if (!looksPublicHost(url.hostname)) throw new NotPublicError();
    const res = await getOnce(url, opts.headers ?? {}, deadline, opts.maxBytes);
    if ("location" in res) {
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      url = new URL(res.location, url);
      continue;
    }
    return { ...res, finalUrl: url.toString(), redirects: hop };
  }
}

type Once = { location: string } | Omit<PublicGetResult, "finalUrl" | "redirects">;

function getOnce(url: URL, headers: Record<string, string>, deadline: number, maxBytes: number): Promise<Once> {
  return new Promise<Once>((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchTimeoutError());
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = mod.request(url, {
      method: "GET", agent: false, lookup: publicLookup,
      headers: { ...headers, "Accept-Encoding": "gzip, deflate, br" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        done(() => resolve({ location }));
        req.destroy();
        return;
      }
      const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
      const body: Readable = enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip())
        : enc === "deflate" ? res.pipe(zlib.createInflate())
        : enc === "br" ? res.pipe(zlib.createBrotliDecompress())
        : res;
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      const finish = () => done(() => resolve({
        status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8"), bytes: size, truncated,
      }));
      body.on("data", (c: Buffer) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (c.length >= room) {
          chunks.push(c.subarray(0, room));
          size += room;
          truncated = true;
          finish();
          req.destroy();
        } else {
          chunks.push(c);
          size += c.length;
        }
      });
      body.on("end", finish);
      body.on("error", (e) => done(() => reject(e)));
      res.on("error", (e) => done(() => reject(e)));
    });
    const timer = setTimeout(() => { done(() => reject(new FetchTimeoutError())); req.destroy(); }, left);
    req.on("error", (e) => done(() => reject(e)));
    req.end();
  });
}
