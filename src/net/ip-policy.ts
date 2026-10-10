import ipaddr from 'ipaddr.js';

/**
 * True only for globally routable unicast addresses. Everything else is
 * refused: loopback, RFC 1918 private ranges, link-local (which includes the
 * 169.254.169.254 cloud metadata endpoint), carrier-grade NAT, multicast,
 * broadcast, documentation/benchmark/reserved blocks, IPv6 unique-local, and
 * IPv6 transition ranges (NAT64, 6to4, Teredo) that can embed an IPv4 target.
 *
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by their IPv4 part,
 * so ::ffff:127.0.0.1 is treated as loopback.
 *
 * This is an allowlist over ipaddr.js's range table: a range the library
 * labels as anything other than plain "unicast" is blocked by default.
 */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() === 'unicast';
}
