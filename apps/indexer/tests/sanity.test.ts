import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

describe('indexer', () => {
  it('POST /webhooks/helius returns 200 for empty array', async () => {
    const req = new Request('http://localhost/webhooks/helius', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: 0, relevant: 0 });
  });
});
