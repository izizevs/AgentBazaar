import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

describe('indexer', () => {
  it('POST /webhooks/helius placeholder returns { ok: true }', async () => {
    const req = new Request('http://localhost/webhooks/helius', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true });
  });
});
