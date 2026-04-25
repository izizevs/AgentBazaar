import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { getSql } from '../src/db/client.js';

const dbUrl = process.env.DATABASE_URL;

const TEST_SECRET = 'Bearer escrow-handler-test-secret-xyz789';
const ESCROW_PROGRAM_ID = 'EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2';

// Tests webhook routing for escrow program transactions.
// Full decode-and-upsert round-trips are in escrow-event-handlers.integration.test.ts.
describe.skipIf(!dbUrl)('POST /webhooks/helius — escrow event routing', () => {
  const RUN = `esc-test-${Date.now()}`;

  beforeAll(() => {
    process.env.HELIUS_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterAll(async () => {
    const sql = getSql();
    await sql`DELETE FROM processed_signatures WHERE signature LIKE ${`${RUN}-%`}`;
  });

  it('counts an escrow transaction as relevant', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhooks/helius', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: TEST_SECRET },
        body: JSON.stringify([
          {
            description: 'test',
            type: 'UNKNOWN',
            source: 'SYSTEM_PROGRAM',
            fee: 5000,
            feePayer: 'So11111111111111111111111111111111111111112',
            signature: `${RUN}-escrow-stub`,
            slot: 300,
            timestamp: 1_700_000_000,
            accountData: [],
            instructions: [
              {
                accounts: [],
                data: 'AAAAAAAAAA==',
                programId: ESCROW_PROGRAM_ID,
                innerInstructions: [],
              },
            ],
          },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Escrow tx with no decodable inner events: relevant=1, processed=1
    expect(body).toMatchObject({ ok: true, processed: 1, relevant: 1 });
  });

  it('skips transactions from unrelated programs', async () => {
    const res = await app.fetch(
      new Request('http://localhost/webhooks/helius', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: TEST_SECRET },
        body: JSON.stringify([
          {
            description: 'test',
            type: 'UNKNOWN',
            source: 'SYSTEM_PROGRAM',
            fee: 5000,
            feePayer: 'So11111111111111111111111111111111111111112',
            signature: `${RUN}-unrelated`,
            slot: 301,
            timestamp: 1_700_000_001,
            accountData: [],
            instructions: [
              {
                accounts: [],
                data: 'AAAAAAAAAA==',
                programId: '11111111111111111111111111111111',
                innerInstructions: [],
              },
            ],
          },
        ]),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, relevant: 0 });
  });

  it('deduplicates a replayed escrow transaction', async () => {
    const sig = `${RUN}-dedup-escrow`;
    const payload = JSON.stringify([
      {
        description: 'test',
        type: 'UNKNOWN',
        source: 'SYSTEM_PROGRAM',
        fee: 5000,
        feePayer: 'So11111111111111111111111111111111111111112',
        signature: sig,
        slot: 302,
        timestamp: 1_700_000_002,
        accountData: [],
        instructions: [
          {
            accounts: [],
            data: 'AAAAAAAAAA==',
            programId: ESCROW_PROGRAM_ID,
            innerInstructions: [],
          },
        ],
      },
    ]);

    const req = () =>
      app.fetch(
        new Request('http://localhost/webhooks/helius', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: TEST_SECRET },
          body: payload,
        }),
      );

    const first = await (await req()).json();
    const second = await (await req()).json();
    expect(first).toMatchObject({ processed: 1 });
    expect(second).toMatchObject({ processed: 0, skipped: 1 });
  });
});
