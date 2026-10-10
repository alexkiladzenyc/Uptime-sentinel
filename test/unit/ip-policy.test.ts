import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../../src/net/ip-policy.js';
import { parseTargetUrl, SsrfBlockedError } from '../../src/net/safe-fetch.js';

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.255.255.254', 'anywhere in 127/8'],
    ['10.0.0.1', 'RFC 1918'],
    ['172.16.5.4', 'RFC 1918'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'Alibaba metadata (CGNAT)'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['240.0.0.1', 'reserved'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fd00:ec2::254', 'AWS IPv6 metadata'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['64:ff9b::7f00:1', 'NAT64 embedding 127.0.0.1'],
    ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'IPv6 documentation'],
    ['not-an-ip', 'garbage'],
  ])('blocks %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public address %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe('parseTargetUrl', () => {
  it.each([
    ['ftp://example.com/', /scheme "ftp"/],
    ['file:///etc/passwd', /scheme "file"/],
    ['gopher://example.com/', /scheme "gopher"/],
    ['javascript:alert(1)', /scheme "javascript"/],
    ['https://user:pass@example.com/', /credentials/],
    ['not a url', /not a valid URL/],
    ['http://127.0.0.1:6379/', /127\.0\.0\.1 is not publicly routable/],
    ['http://169.254.169.254/latest/meta-data/', /169\.254\.169\.254/],
    ['http://[::1]/', /::1 is not publicly routable/],
    ['http://[::ffff:127.0.0.1]/', /not publicly routable/],
    // Alternate IPv4 spellings are normalised by the URL parser, then blocked.
    ['http://2130706433/', /127\.0\.0\.1/],
    ['http://0x7f.1/', /127\.0\.0\.1/],
    ['http://017700000001/', /127\.0\.0\.1/],
    ['http://0/', /0\.0\.0\.0/],
  ])('rejects %s', (url, message) => {
    expect(() => parseTargetUrl(url)).toThrow(SsrfBlockedError);
    expect(() => parseTargetUrl(url)).toThrow(message);
  });

  it('accepts public http(s) URLs', () => {
    expect(parseTargetUrl('https://example.com/health').href).toBe('https://example.com/health');
    expect(parseTargetUrl('http://8.8.8.8:8080/').port).toBe('8080');
  });

  it('leaves hostnames to be checked at connection time', () => {
    // "localhost" is only dangerous once resolved; safeFetch checks that.
    expect(() => parseTargetUrl('http://localhost/')).not.toThrow();
  });
});
