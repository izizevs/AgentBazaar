/**
 * Unit tests for fetch-metadata.ts — Zod schema failure path and basic
 * scheme/URL rejection. SSRF rejection tests (private IP, redirect, oversized)
 * live in fetch-metadata-ssrf.test.ts (PR #80: Task #43).
 *
 * Transport layer: fetchMetadata uses node:https.request (not globalThis.fetch),
 * so we stub via stubHttpsRequest / makeMockStream from the shared helpers.
 *
 * NOTE on mock lifecycle:
 *   - vi.mock('node:dns/promises') creates a persistent module mock for the
 *     entire file. We use vi.clearAllMocks() in afterEach so call history is
 *     reset but the lookup vi.fn() implementation is preserved.
 *   - https.request spies are set up with vi.spyOn per-test and torn down via
 *     vi.restoreAllMocks() in afterEach.
 *   - After vi.restoreAllMocks() the dns mock implementation is re-applied so
 *     subsequent tests still see a valid public IP from DNS.
 */
import * as dnsPromises from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMetadata } from '../src/events/fetch-metadata.js';
import { makeMockStream, stubHttpsRequest } from './helpers/mock-https.js';

// Module-level DNS mock — always resolves to a safe public IP.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue({ address: '1.2.3.4', family: 4 }),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks(); // restore https.request spies
  // Re-apply default lookup mock after restoreAllMocks clears it
  vi.mocked(dnsPromises.lookup).mockResolvedValue({ address: '1.2.3.4', family: 4 } as never);
});

// ── Scheme allowlist ──────────────────────────────────────────────────────────

describe('fetchMetadata — scheme allowlist', () => {
  it('rejects http:// scheme', async () => {
    const result = await fetchMetadata('http://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('rejects data: scheme', async () => {
    const result = await fetchMetadata('data:application/json,{}');
    expect(result).toBeNull();
  });

  it('rejects ipfs:// with non-alphanumeric CID (path traversal attempt)', async () => {
    const result = await fetchMetadata('ipfs://../../etc/passwd');
    expect(result).toBeNull();
  });

  it('accepts ipfs:// with valid CID and translates to IPFS gateway URL', async () => {
    const payload = {
      name: 'IPFS Agent',
      description: 'fetched from IPFS',
      capability: 'text-summarizer',
      endpoint: 'https://agent.example.com',
    };
    stubHttpsRequest(makeMockStream(200, JSON.stringify(payload)));

    const result = await fetchMetadata(
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y27nf3efuylqabf3oclgtqy55fbzdi',
    );
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('text-summarizer');
  });
});

// ── Successful parse ──────────────────────────────────────────────────────────

describe('fetchMetadata — successful parse', () => {
  it('returns full parsed metadata on valid input', async () => {
    const payload = {
      name: 'Test Agent',
      description: 'A capable agent',
      capability: 'text-analysis-v1',
      endpoint: 'https://agent.example.com/v1',
      avatar: 'https://cdn.example.com/avatar.png',
    };
    stubHttpsRequest(makeMockStream(200, JSON.stringify(payload)));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toMatchObject(payload);
  });

  it('accepts metadata without optional avatar field', async () => {
    const payload = {
      name: 'Minimal Agent',
      description: '',
      capability: 'translation',
      endpoint: 'https://translator.example.com',
    };
    stubHttpsRequest(makeMockStream(200, JSON.stringify(payload)));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('translation');
    expect(result?.avatar).toBeUndefined();
  });
});

// ── Zod schema failures ───────────────────────────────────────────────────────

describe('fetchMetadata — Zod schema failures', () => {
  it('returns null when body is not valid JSON', async () => {
    stubHttpsRequest(makeMockStream(200, 'not-json'));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when metadata is missing required fields (no capability)', async () => {
    stubHttpsRequest(makeMockStream(200, JSON.stringify({ name: 'Agent', description: 'desc' })));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when endpoint uses http (not https)', async () => {
    stubHttpsRequest(
      makeMockStream(
        200,
        JSON.stringify({
          name: 'Agent',
          description: 'desc',
          capability: 'cap',
          endpoint: 'http://insecure.example.com',
        }),
      ),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when capability is empty string', async () => {
    stubHttpsRequest(
      makeMockStream(
        200,
        JSON.stringify({
          name: 'Agent',
          description: 'desc',
          capability: '',
          endpoint: 'https://agent.example.com',
        }),
      ),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when name exceeds 64 chars', async () => {
    stubHttpsRequest(
      makeMockStream(
        200,
        JSON.stringify({
          name: 'A'.repeat(65),
          description: 'desc',
          capability: 'cap',
          endpoint: 'https://agent.example.com',
        }),
      ),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });
});

// ── HTTP error responses ──────────────────────────────────────────────────────

describe('fetchMetadata — HTTP error responses', () => {
  it('returns null for non-2xx status', async () => {
    stubHttpsRequest(makeMockStream(404, 'Not Found'));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when https.request emits an error event', async () => {
    const { EventEmitter } = await import('node:events');
    const https = await import('node:https');
    vi.spyOn(https.default, 'request').mockImplementation((_opts: unknown, _cb?: unknown) => {
      const req = new EventEmitter() as unknown as ReturnType<typeof https.default.request>;
      (req as unknown as { end: () => void }).end = () => {
        setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
      };
      (req as unknown as { destroy: () => void }).destroy = () => {};
      return req;
    });
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });
});
