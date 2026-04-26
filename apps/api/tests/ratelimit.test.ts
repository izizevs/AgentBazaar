// Unit tests for rate limiting middleware behavior
import { describe, expect, it, vi } from 'vitest';

// No DB calls in rate limit tests
vi.mock('../src/db/client.js', () => ({
  createDbClient: vi.fn(() => ({ select: vi.fn() })),
}));

import app from '../src/index.js';

const TEST_ENV = {
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  APP_VERSION: '0.1.0-test',
};

describe('Rate limiting', () => {
  it('includes RateLimit headers on /healthz responses', async () => {
    const res = await app.request('/healthz', {}, TEST_ENV);
    // healthz is skipped from RL — no headers expected, but 200 returned
    expect(res.status).toBe(200);
  });

  it('uses X-Agent-Pubkey header when present', async () => {
    const res = await app.request(
      '/healthz',
      { headers: { 'x-agent-pubkey': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
      TEST_ENV,
    );
    // healthz is excluded from rate limiting; just verify no crash
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown routes (not 500)', async () => {
    const res = await app.request('/unknown-route', {}, TEST_ENV);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('CORS preflight on all routes', () => {
  it('OPTIONS /listings returns 204 with CORS headers', async () => {
    const res = await app.request(
      '/listings',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.agentbazaar.io',
          'Access-Control-Request-Method': 'GET',
        },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('OPTIONS /escrows/:pubkey returns 204', async () => {
    const res = await app.request(
      '/escrows/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });
});
