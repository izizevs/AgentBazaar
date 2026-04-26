/**
 * SSRF hardening tests for fetch-metadata.ts (Task #43).
 *
 * Tests cover:
 *  - Private/loopback IP rejection (I2 DNS pinning)
 *  - H1 regression: IPv4-mapped IPv6 (::ffff:x.x.x.x), 0.0.0.0, uppercase IPv6
 *  - Redirect rejection (Layer 3)
 *  - Oversized body rejection (I1 streaming cap)
 *  - DNS failure treated as blocked (fail-closed)
 *  - Scheme allowlist
 *
 * Mock strategy:
 *  - node:dns/promises is replaced by a module-level vi.mock so the
 *    lookup vi.fn() is available via dnsPromises.lookup.
 *  - node:https.request is spied on per-test via vi.spyOn.
 *  - vi.clearAllMocks() preserves mock implementations between tests;
 *    vi.unstubAllGlobals() is not needed here since we don't stubGlobal.
 */

import * as dnsPromises from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMetadata } from '../src/events/fetch-metadata.js';
import { makeMockStream, stubHttpsRequest } from './helpers/mock-https.js';

// Module-level DNS mock — lookup vi.fn() persists for the whole file.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue({ address: '1.2.3.4', family: 4 }),
}));

afterEach(() => {
  // Clear call history and reset mock implementations to their initial state
  // (preserves module mock structure; each test re-configures as needed).
  vi.clearAllMocks();
  vi.restoreAllMocks(); // restore https.request spies
  // Re-apply default lookup mock after restoreAllMocks clears it
  vi.mocked(dnsPromises.lookup).mockResolvedValue({ address: '1.2.3.4', family: 4 } as never);
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

function setDnsLookup(address: string) {
  vi.mocked(dnsPromises.lookup).mockResolvedValue({ address, family: 4 } as never);
}

function setDnsFailure() {
  vi.mocked(dnsPromises.lookup).mockRejectedValue(new Error('ENOTFOUND'));
}

// ── DNS pinning (I2) ──────────────────────────────────────────────────────────

describe('fetchMetadata — DNS pinning (I2)', () => {
  it('rejects loopback 127.0.0.1', async () => {
    setDnsLookup('127.0.0.1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects RFC 1918 — 10.x.x.x', async () => {
    setDnsLookup('10.0.0.1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects RFC 1918 — 192.168.x.x', async () => {
    setDnsLookup('192.168.1.1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects RFC 1918 — 172.16-31.x.x', async () => {
    setDnsLookup('172.20.0.1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects cloud metadata endpoint 169.254.169.254', async () => {
    setDnsLookup('169.254.169.254');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects IPv6 loopback ::1', async () => {
    setDnsLookup('::1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects IPv6 link-local fe80::1', async () => {
    setDnsLookup('fe80::1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  // H1 regression tests — IPv4-mapped IPv6, unspecified addresses, uppercase
  it('rejects IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', async () => {
    setDnsLookup('::ffff:127.0.0.1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects IPv4-mapped IPv6 cloud metadata ::ffff:169.254.169.254', async () => {
    setDnsLookup('::ffff:169.254.169.254');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects unspecified address 0.0.0.0', async () => {
    setDnsLookup('0.0.0.0');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('rejects uppercase IPv6 link-local FE80::1', async () => {
    setDnsLookup('FE80::1');
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('fails closed on DNS lookup error', async () => {
    setDnsFailure();
    expect(await fetchMetadata('https://evil.example.com/meta.json')).toBeNull();
  });

  it('allows a public IP through (happy path)', async () => {
    setDnsLookup('1.2.3.4');
    const payload = JSON.stringify({
      name: 'Agent',
      description: 'ok',
      capability: 'cap-v1',
      endpoint: 'https://agent.example.com',
    });
    stubHttpsRequest(makeMockStream(200, payload));
    const result = await fetchMetadata('https://agent.example.com/meta.json');
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('cap-v1');
  });
});

// ── Scheme allowlist ──────────────────────────────────────────────────────────

describe('fetchMetadata — scheme allowlist', () => {
  it('rejects http:// (no DNS lookup attempted)', async () => {
    const result = await fetchMetadata('http://example.com/meta.json');
    expect(result).toBeNull();
    expect(vi.mocked(dnsPromises.lookup)).not.toHaveBeenCalled();
  });

  it('rejects data: scheme (no DNS lookup attempted)', async () => {
    const result = await fetchMetadata('data:text/plain,hello');
    expect(result).toBeNull();
    expect(vi.mocked(dnsPromises.lookup)).not.toHaveBeenCalled();
  });

  it('rejects ipfs:// with path traversal CID', async () => {
    const result = await fetchMetadata('ipfs://../../etc/passwd');
    expect(result).toBeNull();
    expect(vi.mocked(dnsPromises.lookup)).not.toHaveBeenCalled();
  });
});

// ── Redirect rejection (Layer 3) ─────────────────────────────────────────────

describe('fetchMetadata — redirect rejection', () => {
  it('rejects 301', async () => {
    stubHttpsRequest(makeMockStream(301, ''));
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });

  it('rejects 302', async () => {
    stubHttpsRequest(makeMockStream(302, ''));
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });
});

// ── Streaming 100 KB cap (I1) ─────────────────────────────────────────────────

describe('fetchMetadata — streaming 100 KB cap (I1)', () => {
  it('rejects a body larger than 100 KB (single chunk)', async () => {
    stubHttpsRequest(makeMockStream(200, 'x'.repeat(101_000)));
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });

  it('rejects a body larger than 100 KB (multiple chunks)', async () => {
    stubHttpsRequest(makeMockStream(200, 'y'.repeat(101_000), true));
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });

  it('accepts a valid body at well under 100 KB', async () => {
    const payload = {
      name: 'Agent',
      description: 'desc',
      capability: 'small-payload',
      endpoint: 'https://agent.example.com',
    };
    stubHttpsRequest(makeMockStream(200, JSON.stringify(payload)));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('small-payload');
  });
});

// ── HTTP error responses ──────────────────────────────────────────────────────

describe('fetchMetadata — HTTP error responses', () => {
  it('returns null for 404', async () => {
    stubHttpsRequest(makeMockStream(404, 'Not Found'));
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });

  it('returns null when https.request emits an error event', async () => {
    vi.spyOn(https, 'request').mockImplementation((_opts: unknown, _cb?: unknown) => {
      const req = new EventEmitter() as unknown as ReturnType<typeof https.request>;
      (req as unknown as { end: () => void }).end = () => {
        setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
      };
      (req as unknown as { destroy: () => void }).destroy = () => {};
      return req;
    });
    expect(await fetchMetadata('https://example.com/meta.json')).toBeNull();
  });
});
