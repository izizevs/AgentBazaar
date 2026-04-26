// Unit tests for GET /healthz
import { describe, expect, it } from 'vitest';

import app from '../src/index.js';

const TEST_ENV = {
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  APP_VERSION: '0.1.0-test',
};

describe('GET /healthz', () => {
  it('returns 200 with ok, version, uptime', async () => {
    const res = await app.request('/healthz', {}, TEST_ENV);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; version: string; uptime: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.1.0-test');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('responds to CORS preflight', async () => {
    const res = await app.request(
      '/healthz',
      { method: 'OPTIONS', headers: { Origin: 'https://example.com' } },
      TEST_ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
