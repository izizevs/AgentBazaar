import { web3 } from '@coral-xyz/anchor';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSql } from '../src/db/client.js';
import type {
  DeliverySubmittedData,
  DisputeOpenedData,
  EscrowCreatedData,
  EscrowStateChangedData,
  SlaReportData,
} from '../src/events/escrow-decoder.js';
import { onDeliverySubmitted } from '../src/events/on-delivery-submitted.js';
import { onDisputeOpened } from '../src/events/on-dispute-opened.js';
import { onEscrowCreated } from '../src/events/on-escrow-created.js';
import { onEscrowStateChanged } from '../src/events/on-escrow-state-changed.js';
import { onSlaReport } from '../src/events/on-sla-report.js';

// Run with: INTEGRATION=true pnpm test:integration
// (Requires DATABASE_URL pointing to local Postgres.)

// Use Keypair.generate() so pubkeys are valid base58-encoded 32-byte keys.
// Unique per run — no cleanup collision between parallel test workers.
const ESCROW_PUBKEY = web3.Keypair.generate().publicKey.toBase58();
const BUYER = web3.Keypair.generate().publicKey.toBase58();
const SELLER = web3.Keypair.generate().publicKey.toBase58();
const LISTING = web3.Keypair.generate().publicKey.toBase58();
const TX_SIG = `txsig-integ-${Date.now()}`;

// Helpers that return typed mock event data
function escrowCreatedData(overrides: Partial<EscrowCreatedData> = {}): EscrowCreatedData {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    escrow: { toString: () => ESCROW_PUBKEY },
    buyer: { toString: () => BUYER },
    seller: { toString: () => SELLER },
    listing: { toString: () => LISTING },
    amount: { toString: () => '1000000' },
    deadlineTs: { toString: () => String(nowSec + 3600) },
    createdAt: { toString: () => String(nowSec) },
    ...overrides,
  };
}

function stateChangedData(
  newStateName: string,
  overrides: Partial<EscrowStateChangedData> = {},
): EscrowStateChangedData {
  return {
    escrow: { toString: () => ESCROW_PUBKEY },
    buyer: { toString: () => BUYER },
    seller: { toString: () => SELLER },
    oldState: { created: {} },
    newState: { [newStateName]: {} },
    timestamp: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

function deliverySubmittedData(
  overrides: Partial<DeliverySubmittedData> = {},
): DeliverySubmittedData {
  return {
    escrow: { toString: () => ESCROW_PUBKEY },
    seller: { toString: () => SELLER },
    resultUri: 'https://example.com/result',
    resultHash: Array.from<number>({ length: 32 }).fill(0xab),
    deliveredAt: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

function slaReportData(overrides: Partial<SlaReportData> = {}): SlaReportData {
  return {
    escrow: { toString: () => ESCROW_PUBKEY },
    buyer: { toString: () => BUYER },
    seller: { toString: () => SELLER },
    severity: { minor: {} },
    sellerBps: { toString: () => '9500' },
    refundBps: { toString: () => '500' },
    score: 85,
    tags: ['fast'],
    confirmedAt: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

function disputeOpenedData(overrides: Partial<DisputeOpenedData> = {}): DisputeOpenedData {
  return {
    escrow: { toString: () => ESCROW_PUBKEY },
    buyer: { toString: () => BUYER },
    reason: 'incomplete work',
    evidenceUri: 'https://example.com/evidence',
    openedAt: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

describe.skipIf(process.env.INTEGRATION !== 'true')(
  'indexer integration — escrow event handlers DB round-trip',
  () => {
    let sql: ReturnType<typeof getSql>;

    beforeAll(() => {
      sql = getSql();
    });

    afterAll(async () => {
      // Clean up in FK-safe order (sla_reports → escrows, then reputation)
      await sql`DELETE FROM sla_reports WHERE escrow_pubkey = ${ESCROW_PUBKEY}`;
      await sql`DELETE FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      await sql`DELETE FROM agent_reputation WHERE wallet = ${SELLER}`;
      await sql.end();
    });

    it('onEscrowCreated — inserts escrow row with state=created', async () => {
      await onEscrowCreated(TX_SIG, escrowCreatedData());

      const rows =
        await sql`SELECT state, buyer, seller, amount_usdc FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'created',
        buyer: BUYER,
        seller: SELLER,
        amount_usdc: '1000000',
      });
    });

    it('onEscrowCreated — idempotent on replay (ON CONFLICT DO NOTHING)', async () => {
      await onEscrowCreated(TX_SIG, escrowCreatedData());
      const rows = await sql`SELECT COUNT(*) as cnt FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(Number((rows[0] as { cnt: string }).cnt)).toBe(1);
    });

    it('onDeliverySubmitted — updates result_uri, result_hash, state=delivered', async () => {
      await onDeliverySubmitted(TX_SIG, deliverySubmittedData());

      const rows =
        await sql`SELECT state, result_uri, result_hash FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(rows[0]).toMatchObject({
        state: 'delivered',
        result_uri: 'https://example.com/result',
      });
      expect(
        Buffer.isBuffer((rows[0] as { result_hash: Buffer }).result_hash) ||
          (rows[0] as { result_hash: unknown }).result_hash != null,
      ).toBe(true);
    });

    it('onEscrowStateChanged — updates state column', async () => {
      await onEscrowStateChanged(TX_SIG, stateChangedData('confirmed'));

      const rows = await sql`SELECT state FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(rows[0]).toMatchObject({ state: 'confirmed' });
    });

    it('onSlaReport — inserts sla_report row with correct severity + refund_pct', async () => {
      // refundBps=500 → refundPct=5
      await onSlaReport(TX_SIG, slaReportData());

      const rows =
        await sql`SELECT severity, refund_pct FROM sla_reports WHERE escrow_pubkey = ${ESCROW_PUBKEY}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ severity: 'minor', refund_pct: 5 });
    });

    it('onSlaReport — seeds agent_reputation on first job', async () => {
      const rows =
        await sql`SELECT jobs_completed, avg_score, total_score FROM agent_reputation WHERE wallet = ${SELLER}`;
      expect(rows).toHaveLength(1);
      expect(Number((rows[0] as { jobs_completed: string }).jobs_completed)).toBe(1);
      expect(Number((rows[0] as { avg_score: number }).avg_score)).toBe(85);
      expect(Number((rows[0] as { total_score: string }).total_score)).toBe(85);
    });

    it('onSlaReport — increments reputation + recomputes avg_score on second job', async () => {
      // score=75 → total=85+75=160, jobs=2, avg=80
      await onSlaReport(`${TX_SIG}-2`, slaReportData({ score: 75 }));

      const rows =
        await sql`SELECT jobs_completed, avg_score, total_score FROM agent_reputation WHERE wallet = ${SELLER}`;
      expect(Number((rows[0] as { jobs_completed: string }).jobs_completed)).toBe(2);
      expect(Number((rows[0] as { total_score: string }).total_score)).toBe(160);
      expect(Number((rows[0] as { avg_score: number }).avg_score)).toBe(80);
    });

    it('onDisputeOpened — updates state to disputed', async () => {
      // Reset state to created first for a clean test
      await sql`UPDATE escrows SET state = 'created' WHERE pubkey = ${ESCROW_PUBKEY}`;

      await onDisputeOpened(TX_SIG, disputeOpenedData());

      const rows = await sql`SELECT state FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(rows[0]).toMatchObject({ state: 'disputed' });
    });

    it('onEscrowStateChanged maps timeout_claimed correctly', async () => {
      await onEscrowStateChanged(TX_SIG, stateChangedData('timeoutClaimed'));
      const rows = await sql`SELECT state FROM escrows WHERE pubkey = ${ESCROW_PUBKEY}`;
      expect(rows[0]).toMatchObject({ state: 'timeout_claimed' });
    });
  },
);
