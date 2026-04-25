import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { getSql } from '../src/db/client.js';

const REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd';
const TEST_SECRET = 'Bearer test-webhook-secret-replay';

const dbUrl = process.env['DATABASE_URL'];

function makeEvent(signature: string, programId = REGISTRY_PROGRAM_ID) {
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

async function post(body: unknown): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/webhooks/helius', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: TEST_SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(!dbUrl)('POST /webhooks/helius — replay protection', () => {
  beforeAll(() => {
    process.env['HELIUS_WEBHOOK_SECRET'] = TEST_SECRET;
  });

  afterAll(async () => {
    // Clean up test signatures so tests are repeatable.
    const sql = getSql();
    await sql`DELETE FROM processed_signatures WHERE signature LIKE 'replay-test-%'`;
  });

  it('processes a new event and records its signature', async () => {
    const sig = 'replay-test-new-1';
    const res = await post([makeEvent(sig)]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, relevant: 1, skipped: 0 });

    // Verify signature recorded in DB
    const sql = getSql();
    const rows = await sql`SELECT signature FROM processed_signatures WHERE signature = ${sig}`;
    expect(rows).toHaveLength(1);
  });

  it('skips already-processed signatures (idempotent replay)', async () => {
    const sig = 'replay-test-dup-1';

    // First delivery
    const first = await post([makeEvent(sig)]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ processed: 1, relevant: 1, skipped: 0 });

    // Helius re-delivers same event (e.g. after our endpoint returned 5xx)
    const second = await post([makeEvent(sig)]);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body).toMatchObject({ ok: true, processed: 0, relevant: 0, skipped: 1 });
  });

  it('processes only new signatures in a mixed batch', async () => {
    const sigOld = 'replay-test-old-1';
    const sigNew = 'replay-test-mixed-new-1';

    // Pre-seed the old signature
    await post([makeEvent(sigOld)]);

    // Batch with one seen + one new
    const res = await post([makeEvent(sigOld), makeEvent(sigNew)]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, relevant: 1, skipped: 1 });
  });
});
