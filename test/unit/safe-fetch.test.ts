import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  safeFetch,
  SsrfBlockedError,
  type AddressPolicy,
  type Resolver,
} from '../../src/net/safe-fetch.js';

const fixtures = path.join(import.meta.dirname, '..', 'fixtures');
const cert = readFileSync(path.join(fixtures, 'localhost-cert.pem'));
const key = readFileSync(path.join(fixtures, 'localhost-key.pem'));

// Tests run servers on 127.0.0.1, so they treat exactly that address as
// "public". Every other private address stays blocked, which is what lets
// these tests prove the blocking logic against a real socket.
const onlyLoopback: AddressPolicy = (ip) => ip === '127.0.0.1';

const servers: (http.Server | https.Server)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Handler = http.RequestListener;
async function serve(handler: Handler, tls = false) {
  const hits: string[] = [];
  const wrapped: Handler = (req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  };
  const server = tls ? https.createServer({ cert, key }, wrapped) : http.createServer(wrapped);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { port, hits };
}

/** Resolver that answers from a fixed table, counting lookups per host. */
function fakeDns(table: Record<string, string[] | (() => string[])>) {
  const calls: Record<string, number> = {};
  const resolver: Resolver = async (host) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const entry = table[host];
    if (!entry)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const ips = typeof entry === 'function' ? entry() : entry;
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
  };
  return { resolver, calls };
}

const ok: Handler = (_req, res) => res.end('ok');

describe('safeFetch', () => {
  it('fetches an allowed URL and reports status and timing', async () => {
    const { port } = await serve(ok);
    const { resolver } = fakeDns({ 'site.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://site.test:${port}/`, {
      timeoutMs: 2000,
      resolver,
      addressPolicy: onlyLoopback,
    });
    expect(res).toMatchObject({
      status: 200,
      bodyBytes: 2,
      redirects: [],
      remoteAddress: '127.0.0.1',
    });
    expect(res.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('blocks a hostname that resolves to a private address, before connecting', async () => {
    const { port, hits } = await serve(ok);
    const { resolver } = fakeDns({ 'evil.test': ['127.0.0.1'] });
    // Default policy: loopback is not public.
    await expect(
      safeFetch(`http://evil.test:${port}/`, { timeoutMs: 2000, resolver }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(hits).toHaveLength(0);
  });

  it('blocks when any address in the DNS answer is private', async () => {
    const { port, hits } = await serve(ok);
    const { resolver } = fakeDns({ 'mixed.test': ['127.0.0.1', '10.0.0.7'] });
    await expect(
      safeFetch(`http://mixed.test:${port}/`, {
        timeoutMs: 2000,
        resolver,
        addressPolicy: onlyLoopback,
      }),
    ).rejects.toThrow(/resolves to 10\.0\.0\.7/);
    expect(hits).toHaveLength(0);
  });

  it('resolves once per connection and connects to the validated address (no DNS rebinding)', async () => {
    const { port, hits } = await serve(ok);
    // A rebinding DNS server answers "safe" first and "internal" afterwards. A
    // check-then-connect implementation would validate the first answer and
    // connect using the second.
    let n = 0;
    const { resolver, calls } = fakeDns({
      'rebind.test': () => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.7']),
    });
    const res = await safeFetch(`http://rebind.test:${port}/`, {
      timeoutMs: 2000,
      resolver,
      addressPolicy: onlyLoopback,
    });
    expect(calls['rebind.test']).toBe(1);
    expect(res.remoteAddress).toBe('127.0.0.1');
    expect(hits).toHaveLength(1);
  });

  it('re-validates every redirect hop', async () => {
    const { port } = await serve((req, res) => {
      const targets: Record<string, string> = {
        '/to-metadata': 'http://169.254.169.254/latest/meta-data/',
        '/to-internal-name': `http://internal.test:${port}/admin`,
        '/to-file': 'file:///etc/passwd',
        '/to-ipv6-loopback': `http://[::1]:${port}/`,
      };
      res.writeHead(302, { location: targets[req.url ?? ''] ?? '/' }).end();
    });
    const { resolver } = fakeDns({ 'site.test': ['127.0.0.1'], 'internal.test': ['10.1.2.3'] });
    const opts = { timeoutMs: 2000, resolver, addressPolicy: onlyLoopback };

    await expect(safeFetch(`http://site.test:${port}/to-metadata`, opts)).rejects.toThrow(
      /169\.254\.169\.254 is not publicly routable/,
    );
    await expect(safeFetch(`http://site.test:${port}/to-internal-name`, opts)).rejects.toThrow(
      /internal\.test resolves to 10\.1\.2\.3/,
    );
    await expect(safeFetch(`http://site.test:${port}/to-file`, opts)).rejects.toThrow(
      /scheme "file"/,
    );
    await expect(safeFetch(`http://site.test:${port}/to-ipv6-loopback`, opts)).rejects.toThrow(
      /::1 is not publicly routable/,
    );
  });

  it('follows allowed redirects and records the chain', async () => {
    const { port } = await serve((req, res) => {
      if (req.url === '/a') res.writeHead(301, { location: '/b' }).end();
      else if (req.url === '/b')
        res.writeHead(307, { location: `http://site.test:${port}/c` }).end();
      else res.end('done');
    });
    const { resolver } = fakeDns({ 'site.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://site.test:${port}/a`, {
      timeoutMs: 2000,
      resolver,
      addressPolicy: onlyLoopback,
    });
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(`http://site.test:${port}/c`);
    expect(res.redirects).toEqual([`http://site.test:${port}/a`, `http://site.test:${port}/b`]);
  });

  it('caps the number of redirects', async () => {
    const { port } = await serve((_req, res) => res.writeHead(302, { location: '/again' }).end());
    const { resolver } = fakeDns({ 'loop.test': ['127.0.0.1'] });
    await expect(
      safeFetch(`http://loop.test:${port}/`, {
        timeoutMs: 2000,
        resolver,
        addressPolicy: onlyLoopback,
        maxRedirects: 3,
      }),
    ).rejects.toThrow('too many redirects (more than 3)');
  });

  it('enforces the total timeout', async () => {
    const { port } = await serve(() => {
      /* never responds */
    });
    const { resolver } = fakeDns({ 'slow.test': ['127.0.0.1'] });
    const started = Date.now();
    await expect(
      safeFetch(`http://slow.test:${port}/`, {
        timeoutMs: 200,
        resolver,
        addressPolicy: onlyLoopback,
      }),
    ).rejects.toThrow('timed out after 200ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops reading after maxBodyBytes', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const { port } = await serve((_req, res) => {
      let sent = 0;
      const pump = () => {
        while (sent < 5 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const { resolver } = fakeDns({ 'big.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://big.test:${port}/`, {
      timeoutMs: 5000,
      resolver,
      addressPolicy: onlyLoopback,
      maxBodyBytes: 100_000,
    });
    expect(res).toMatchObject({ status: 200, bodyBytes: 100_000, bodyTruncated: true });
  });

  it('reads the TLS certificate of an https target', async () => {
    const { port } = await serve(ok, true);
    const { resolver } = fakeDns({ localhost: ['127.0.0.1'] });
    const res = await safeFetch(`https://localhost:${port}/`, {
      timeoutMs: 2000,
      resolver,
      addressPolicy: onlyLoopback,
      ca: cert,
    });
    expect(res.status).toBe(200);
    expect(res.certificate).toMatchObject({ subject: 'localhost', issuer: 'localhost' });
    expect(res.certificate!.validTo.getUTCFullYear()).toBeGreaterThan(2100);
    expect(res.certificate!.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('fails on an untrusted certificate', async () => {
    const { port } = await serve(ok, true);
    const { resolver } = fakeDns({ localhost: ['127.0.0.1'] });
    await expect(
      safeFetch(`https://localhost:${port}/`, {
        timeoutMs: 2000,
        resolver,
        addressPolicy: onlyLoopback,
      }),
    ).rejects.toThrow(/self-signed certificate/);
  });

  it('reports DNS failures', async () => {
    const { resolver } = fakeDns({});
    await expect(safeFetch('http://nowhere.test/', { timeoutMs: 2000, resolver })).rejects.toThrow(
      /ENOTFOUND nowhere\.test/,
    );
  });
});
