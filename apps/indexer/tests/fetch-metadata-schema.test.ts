/**
 * Unit tests for fetch-metadata.ts — Zod schema failure path and basic
 * scheme/URL rejection. SSRF rejection tests (private IP, redirect, oversized)
 * live in fetch-metadata-ssrf.test.ts (PR #2: Task #43).
 *
 * These tests mock globalThis.fetch so no real HTTP is made.
 *
 * NOTE on mock lifecycle:
 *   - vi.mock('node:dns/promises') creates a persistent module mock for the
 *     entire file. We use vi.clearAllMocks() (not restoreAllMocks()) in
 *     afterEach so the lookup vi.fn() implementation is NOT reset between
 *     tests — restoreAllMocks() would remove the implementation, causing
 *     DNS checks to throw and fail-closed (returning null from fetchMetadata).
 *   - Per-test fetch mocks are set up with vi.stubGlobal so they are cleaned
 *     up by vi.unstubAllGlobals() without affecting module mocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMetadata } from '../src/events/fetch-metadata.js';

// Module-level DNS mock. Must NOT be cleared with restoreAllMocks().
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue({ address: '1.2.3.4', family: 4 }),
}));

afterEach(() => {
  // Clear call history but preserve mock implementations (including the
  // dns/promises lookup mock installed above).
  vi.clearAllMocks();
  // Restore any global stubs (fetch) installed via vi.stubGlobal.
  vi.unstubAllGlobals();
});

function makeResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    // text() is used by the current fetchMetadata implementation
    text: () => Promise.resolve(body),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}

/** Stub globalThis.fetch for a single call. Cleaned up by vi.unstubAllGlobals(). */
function stubFetch(body: string, status = 200, headers: Record<string, string> = {}) {
  const fn = vi.fn().mockResolvedValue(makeResponse(body, status, headers) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

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
    const fetchFn = stubFetch(JSON.stringify(payload));

    const result = await fetchMetadata(
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y27nf3efuylqabf3oclgtqy55fbzdi',
    );
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('text-summarizer');
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('bafybeigdyrzt5sfp7udm7hu76uh7y27nf3efuylqabf3oclgtqy55fbzdi'),
      expect.any(Object),
    );
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
    stubFetch(JSON.stringify(payload));
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
    stubFetch(JSON.stringify(payload));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).not.toBeNull();
    expect(result?.capability).toBe('translation');
    expect(result?.avatar).toBeUndefined();
  });
});

// ── Zod schema failures ───────────────────────────────────────────────────────

describe('fetchMetadata — Zod schema failures', () => {
  it('returns null when body is not valid JSON', async () => {
    stubFetch('not-json');
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when metadata is missing required fields (no capability)', async () => {
    stubFetch(JSON.stringify({ name: 'Agent', description: 'desc' }));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when endpoint uses http (not https)', async () => {
    stubFetch(
      JSON.stringify({
        name: 'Agent',
        description: 'desc',
        capability: 'cap',
        endpoint: 'http://insecure.example.com',
      }),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when capability is empty string', async () => {
    stubFetch(
      JSON.stringify({
        name: 'Agent',
        description: 'desc',
        capability: '',
        endpoint: 'https://agent.example.com',
      }),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when name exceeds 64 chars', async () => {
    stubFetch(
      JSON.stringify({
        name: 'A'.repeat(65),
        description: 'desc',
        capability: 'cap',
        endpoint: 'https://agent.example.com',
      }),
    );
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });
});

// ── HTTP error responses ──────────────────────────────────────────────────────

describe('fetchMetadata — HTTP error responses', () => {
  it('returns null for non-2xx status', async () => {
    stubFetch('Not Found', 404);
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    const result = await fetchMetadata('https://example.com/meta.json');
    expect(result).toBeNull();
  });
});
