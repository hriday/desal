import { BlockList, isIP } from 'node:net';

/**
 * Peers whose X-Forwarded-For is trusted: loopback and the private ranges. In production the
 * gateway's port is published only on 127.0.0.1 and Caddy on the host reaches it through Docker's
 * proxy/NAT, so the peer inside the container is the bridge gateway (e.g. 172.18.0.1), never
 * loopback. Any private peer can only be that host proxy path. IPv4-mapped IPv6 peers
 * (::ffff:a.b.c.d) are unmapped before the check, so the IPv4 ranges cover them too.
 */
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';

/** Parse a comma-separated CIDR list (TRUSTED_PROXIES); throws on a malformed entry. */
export function trustedProxies(spec: string): BlockList {
  const list = new BlockList();
  for (const entry of spec.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const [addr, bits, extra] = entry.split('/');
    const family = addr ? isIP(addr) : 0;
    const prefix = Number(bits);
    const max = family === 6 ? 128 : 32;
    if (family === 0 || extra !== undefined || bits === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`TRUSTED_PROXIES: bad CIDR "${entry}"`);
    }
    list.addSubnet(addr!, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** An address as { address, family }, with ::ffff:a.b.c.d unmapped and any %zone dropped; null if not an IP. */
function parseIp(raw: string | undefined): { address: string; family: 4 | 6 } | null {
  if (!raw) return null;
  let a = raw.trim().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1]!;
  const family = isIP(a);
  return family === 0 ? null : { address: a, family: family as 4 | 6 };
}

/** The first four hextets of an IPv6 address (its /64), expanded and without leading zeros. */
function ipv6Prefix64(address: string): string {
  let a = address.toLowerCase();
  // An embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4) becomes two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
    a = a.slice(0, v4.index) + `${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, tail] = a.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** A client id: IPv4 as is; IPv6 grouped by /64, since one host or household usually owns a whole /64. */
function idOf(ip: { address: string; family: 4 | 6 }): string {
  return ip.family === 4 ? ip.address : ipv6Prefix64(ip.address);
}

/**
 * Who a connection belongs to, for the per-client limits: X-Forwarded-For's first address when
 * the TCP peer is a trusted proxy (Caddy sets that header, replacing whatever the client sent),
 * else the peer itself. From an untrusted peer the header is ignored: anyone could make it up.
 */
export function clientIdOf(peer: string | undefined, forwardedFor: string | string[] | undefined, trusted: BlockList): string {
  const p = parseIp(peer);
  if (!p) return 'unknown';
  if (trusted.check(p.address, p.family === 6 ? 'ipv6' : 'ipv4')) {
    const xff = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const client = parseIp(xff?.split(',')[0]);
    if (client) return idOf(client);
  }
  return idOf(p);
}
