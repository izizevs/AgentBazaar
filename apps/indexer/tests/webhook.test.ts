import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

const REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd';
const OTHER_PROGRAM_ID = '11111111111111111111111111111111';
const TEST_SECRET = 'Bearer test-webhook-secret-abc123';
const RUN = `wh-test-${Date.now()}`;

beforeAll(() => {
  process.env.HELIUS_WEBHOOK_SECRET = TEST_SECRET;
});

afterAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const { getSql } = await import('../src/db/client.js');
    const sql = getSql();
    await sql`DELETE FROM processed_signatures WHERE signature LIKE ${`${RUN}-%`}`;
  }
});

function makeEvent(programId: string, signature = `${RUN}-default`) {
  return {
    description: 'test',
    type: 'UNKNOWN',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: 'So11111111111111111111111111111111111111112',
    signature,
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

async function post(body: unknown, authHeader?: string): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/webhooks/helius', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: authHeader ?? TEST_SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /webhooks/helius — auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhooks/helius', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([]),
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 401 when Authorization header is wrong', async () => {
    const res = await post([], 'Bearer wrong-secret');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct Authorization header', async () => {
    const res = await post([]);
    expect(res.status).toBe(200);
  });
});

describe('POST /webhooks/helius — payload validation', () => {
  it('returns 200 with empty array payload', async () => {
    const res = await post([]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 0, relevant: 0 });
  });

  it('returns 200 and counts relevant registry events', async () => {
    const res = await post([
      makeEvent(REGISTRY_PROGRAM_ID, `${RUN}-a`),
      makeEvent(OTHER_PROGRAM_ID, `${RUN}-b`),
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 2, relevant: 1 });
  });

  it('returns 200 with zero relevant for non-registry events', async () => {
    const res = await post([makeEvent(OTHER_PROGRAM_ID, `${RUN}-c`)]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, relevant: 0 });
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhooks/helius', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: TEST_SECRET,
        },
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
