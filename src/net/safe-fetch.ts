import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { TLSSocket } from 'node:tls';
import { isPublicAddress } from './ip-policy.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type AddressPolicy = (ip: string) => boolean;

export const systemResolver: Resolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** The request was refused because of where it would have gone. */
export class SsrfBlockedError extends Error {
  override name = 'SsrfBlockedError';
}

export interface SafeFetchOptions {
  /** Total budget for the whole request, redirects included. */
  timeoutMs: number;
  maxRedirects?: number;
  /** Stop reading the body after this many bytes. The check still succeeds. */
  maxBodyBytes?: number;
  signal?: AbortSignal;
  resolver?: Resolver;
  /**
   * Decides which IP addresses may be contacted. Defaults to public unicast
   * only. Tests override it to reach servers on 127.0.0.1; it is never
   * derived from user input.
   */
  addressPolicy?: AddressPolicy;
  /** Extra trusted CA certificates (tests use a self-signed certificate). */
  ca?: string | Buffer;
  userAgent?: string;
}

export interface PeerCertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  fingerprint256: string;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  /** URLs visited before `finalUrl`, in order. */
  redirects: string[];
  /** Time until the final response's headers arrived. */
  responseTimeMs: number;
  bodyBytes: number;
  bodyTruncated: boolean;
  /** The TLS certificate presented for `finalUrl`, if it is https. */
  certificate?: PeerCertificateInfo;
  remoteAddress?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Validates a user-supplied URL before any network access: http(s) only, no
 * embedded credentials, and an IP-literal host must be public. Hostnames are
 * checked later, at connection time, against what DNS actually returns.
 */
export function parseTargetUrl(raw: string | URL, policy: AddressPolicy = isPublicAddress): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`scheme "${url.protocol.replace(':', '')}" is not allowed`);
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('URLs with embedded credentials are not allowed');
  }
  const host = stripBrackets(url.hostname);
  if (!host) throw new SsrfBlockedError('URL has no host');
  // The WHATWG parser already normalised tricks like http://2130706433/ and
  // http://0x7f.1/ to dotted quads, so net.isIP sees the real address here.
  if (net.isIP(host) && !policy(host)) {
    throw new SsrfBlockedError(`address ${host} is not publicly routable`);
  }
  return url;
}

/**
 * Resolves `hostname` and fails if *any* answer is non-public. Rejecting the
 * whole answer (rather than picking a "good" address) means a record set
 * like [8.8.8.8, 10.0.0.5] can't be used to sneak an internal address in.
 */
export async function resolvePublic(
  hostname: string,
  resolver: Resolver = systemResolver,
  policy: AddressPolicy = isPublicAddress,
): Promise<ResolvedAddress[]> {
  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new SsrfBlockedError(`${hostname} did not resolve`);
  const blocked = addresses.find((a) => !policy(a.address));
  if (blocked) {
    throw new SsrfBlockedError(
      `${hostname} resolves to ${blocked.address}, which is not publicly routable`,
    );
  }
  return addresses;
}

/**
 * Builds a `lookup` for http.request. Node calls it while opening the
 * socket and connects to exactly the address it returns, so the address we
 * validate is the address we connect to. There is no window for DNS
 * rebinding between a separate "check" lookup and the real connection.
 */
function guardedLookup(resolver: Resolver, policy: AddressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    resolvePublic(hostname, resolver, policy).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
        const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
        if (usable.length === 0) {
          callback(new SsrfBlockedError(`${hostname} has no IPv${wanted} address`), '', 4);
        } else if (options.all) {
          (callback as unknown as (err: null, addrs: ResolvedAddress[]) => void)(null, usable);
        } else {
          callback(null, usable[0]!.address, usable[0]!.family);
        }
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, '', 4),
    );
  };
}

/**
 * GETs a user-supplied URL without letting it reach internal services.
 * Every redirect hop is re-validated; the total time and the number of bytes
 * read are bounded.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const resolver = opts.resolver ?? systemResolver;
  const policy = opts.addressPolicy ?? isPublicAddress;
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;

  const redirects: string[] = [];
  let url = parseTargetUrl(rawUrl, policy);
  for (;;) {
    try {
      const hop = await requestOnce(url, {
        signal,
        lookup: guardedLookup(resolver, policy),
        maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
        ca: opts.ca,
        userAgent:
          opts.userAgent ??
          'UptimeSentinel/0.1 (+https://github.com/alexkiladzenyc/uptime-sentinel)',
      });
      if (REDIRECT_STATUSES.has(hop.status) && hop.location !== undefined) {
        if (redirects.length >= maxRedirects) {
          throw new Error(`too many redirects (more than ${maxRedirects})`);
        }
        redirects.push(url.href);
        url = parseTargetUrl(new URL(hop.location, url), policy);
        continue;
      }
      return { ...hop.result, finalUrl: url.href, redirects };
    } catch (err) {
      if (deadline.aborted) throw new Error(`timed out after ${opts.timeoutMs}ms`, { cause: err });
      throw err;
    }
  }
}

interface HopResult {
  status: number;
  location?: string;
  result: Omit<SafeFetchResult, 'finalUrl' | 'redirects'>;
}

function requestOnce(
  url: URL,
  o: {
    signal: AbortSignal;
    lookup: LookupFunction;
    maxBodyBytes: number;
    ca?: string | Buffer;
    userAgent: string;
  },
): Promise<HopResult> {
  const started = performance.now();
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<HopResult>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'GET',
        agent: false, // fresh socket per request, so `lookup` runs for every hop
        lookup: o.lookup,
        signal: o.signal,
        ca: o.ca,
        headers: { 'user-agent': o.userAgent, accept: '*/*', connection: 'close' },
      },
      (res) => {
        const responseTimeMs = Math.round(performance.now() - started);
        const status = res.statusCode ?? 0;
        const socket = res.socket as TLSSocket;
        const certificate =
          typeof socket.getPeerCertificate === 'function'
            ? toCertInfo(socket.getPeerCertificate())
            : undefined;
        const remoteAddress = res.socket.remoteAddress;
        const location = REDIRECT_STATUSES.has(status) ? res.headers.location : undefined;

        let bodyBytes = 0;
        let bodyTruncated = false;
        const finish = () =>
          resolve({
            status,
            location,
            result: {
              status,
              responseTimeMs,
              bodyBytes,
              bodyTruncated,
              certificate,
              remoteAddress,
            },
          });

        if (location !== undefined) {
          res.destroy();
          finish();
          return;
        }
        res.on('data', (chunk: Buffer) => {
          bodyBytes += chunk.length;
          if (bodyBytes > o.maxBodyBytes) {
            bodyBytes = o.maxBodyBytes;
            bodyTruncated = true;
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', (err) => (bodyTruncated ? finish() : reject(err)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function toCertInfo(
  cert: ReturnType<TLSSocket['getPeerCertificate']>,
): PeerCertificateInfo | undefined {
  if (!cert || !cert.valid_to) return undefined;
  const name = (x: Record<string, string | string[] | undefined> | undefined) =>
    x?.CN ? String(x.CN) : x?.O ? String(x.O) : '';
  return {
    subject: name(cert.subject as unknown as Record<string, string>),
    issuer: name(cert.issuer as unknown as Record<string, string>),
    validFrom: new Date(cert.valid_from),
    validTo: new Date(cert.valid_to),
    fingerprint256: cert.fingerprint256,
  };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
