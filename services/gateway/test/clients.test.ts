import { describe, expect, it } from 'vitest';
import { clientIdOf, DEFAULT_TRUSTED_PROXIES, trustedProxies } from '../src/clients.js';

const trusted = trustedProxies(DEFAULT_TRUSTED_PROXIES);

describe('clientIdOf', () => {
  it('uses X-Forwarded-For when the peer is a trusted proxy: loopback or a Docker bridge gateway', () => {
    expect(clientIdOf('127.0.0.1', '192.0.2.7, 10.0.0.1', trusted)).toBe('192.0.2.7');
    expect(clientIdOf('::1', ' 192.0.2.7 ', trusted)).toBe('192.0.2.7');
    // In production the peer is the bridge gateway seen through docker-proxy/NAT, never loopback.
    expect(clientIdOf('172.18.0.1', '192.0.2.7', trusted)).toBe('192.0.2.7');
    expect(clientIdOf('::ffff:172.18.0.1', '192.0.2.7', trusted)).toBe('192.0.2.7'); // IPv4-mapped form
    expect(clientIdOf('10.1.2.3', '192.0.2.7', trusted)).toBe('192.0.2.7');
    expect(clientIdOf('192.168.1.1', '192.0.2.7', trusted)).toBe('192.0.2.7');
    expect(clientIdOf('fd00::1', '192.0.2.7', trusted)).toBe('192.0.2.7');
  });

  it('ignores X-Forwarded-For from an untrusted (public) peer: anyone could make it up', () => {
    expect(clientIdOf('198.51.100.9', '192.0.2.7', trusted)).toBe('198.51.100.9');
    expect(clientIdOf('::ffff:198.51.100.9', '192.0.2.7', trusted)).toBe('198.51.100.9');
    expect(clientIdOf('172.32.0.1', '192.0.2.7', trusted)).toBe('172.32.0.1'); // just outside 172.16/12
  });

  it('falls back to the peer when X-Forwarded-For is missing or not an address', () => {
    expect(clientIdOf('172.18.0.1', undefined, trusted)).toBe('172.18.0.1');
    expect(clientIdOf('172.18.0.1', 'not-an-ip', trusted)).toBe('172.18.0.1');
    expect(clientIdOf('172.18.0.1', ['192.0.2.9', '192.0.2.10'], trusted)).toBe('192.0.2.9');
    expect(clientIdOf(undefined, undefined, trusted)).toBe('unknown');
  });

  it('groups IPv6 clients by /64 (one host usually owns a whole /64)', () => {
    const a = clientIdOf('127.0.0.1', '2001:db8:1:2:aaaa::1', trusted);
    const b = clientIdOf('127.0.0.1', '2001:0db8:0001:0002:ffff:1:2:3', trusted);
    const other = clientIdOf('127.0.0.1', '2001:db8:1:3::1', trusted);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    expect(clientIdOf('2001:db8:9:9::5', undefined, trusted)).toBe('2001:db8:9:9::/64'); // public IPv6 peer
    expect(clientIdOf('::1', undefined, trusted)).toBe('0:0:0:0::/64');
  });

  it('honours a custom TRUSTED_PROXIES list, and rejects a malformed one', () => {
    const onlyLoopback = trustedProxies('127.0.0.0/8, ::1/128');
    expect(clientIdOf('172.18.0.1', '192.0.2.7', onlyLoopback)).toBe('172.18.0.1');
    expect(clientIdOf('127.0.0.1', '192.0.2.7', onlyLoopback)).toBe('192.0.2.7');
    expect(clientIdOf('127.0.0.1', '192.0.2.7', trustedProxies(''))).toBe('127.0.0.1');
    expect(() => trustedProxies('10.0.0.0/33')).toThrow(/TRUSTED_PROXIES/);
    expect(() => trustedProxies('nope/8')).toThrow(/TRUSTED_PROXIES/);
    expect(() => trustedProxies('10.0.0.0')).toThrow(/TRUSTED_PROXIES/);
  });
});
