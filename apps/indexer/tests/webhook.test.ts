import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

const REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd';
const OTHER_PROGRAM_ID = '11111111111111111111111111111111';

function makeEvent(programId: string) {
  return {
    description: 'test',
    type: 'UNKNOWN',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: 'So11111111111111111111111111111111111111112',
    signature: 'sig123',
    slot: 100,
    timestamp: 1_700_000_000,
    accountData: [],
    instructions: [
      {
        accounts: [],
        data: 'base64data',
        programId,
        innerInstructions: [],
      },
    ],
  };
}

async function post(body: unknown): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/webhooks/helius', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /webhooks/helius', () => {
  it('returns 200 with empty array payload', async () => {
    const res = await post([]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 0, relevant: 0 });
  });

  it('returns 200 and counts relevant registry events', async () => {
    const res = await post([makeEvent(REGISTRY_PROGRAM_ID), makeEvent(OTHER_PROGRAM_ID)]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 2, relevant: 1 });
  });

  it('returns 200 with zero relevant for non-registry events', async () => {
    const res = await post([makeEvent(OTHER_PROGRAM_ID)]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, relevant: 0 });
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhooks/helius', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json{{{',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for payload that is not an array', async () => {
    const res = await post({ signature: 'abc' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for array with malformed event (missing required field)', async () => {
    const res = await post([{ signature: 'abc' }]);
    expect(res.status).toBe(400);
  });
});
