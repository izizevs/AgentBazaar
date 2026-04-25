import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSql } from '../src/db/client.js';
import type {
  ServiceListingCreatedData,
  ServiceListingUpdatedData,
} from '../src/events/decoder.js';
import { onListingCreated } from '../src/events/on-listing-created.js';
import { onListingUpdated } from '../src/events/on-listing-updated.js';

// Stub IPFS fetch so tests focus on DB logic without live-gateway timeouts.
// capability/endpoint columns remain null — expected when IPFS is unreachable.
vi.mock('../src/events/fetch-metadata.js', () => ({
  fetchMetadata: vi.fn().mockResolvedValue(null),
}));

// Run with: INTEGRATION=true DATABASE_URL=... pnpm test:integration
// Skipped in unit-test CI (no DATABASE_URL + INTEGRATION flag).
const RUN = `integ-${Date.now()}`;
const PUBKEY = `IntegListing1111111111111111${RUN.slice(-8)}`;
const OWNER = 'owner111111111111111111111111111111';
// Uses ipfs:// so fetchMetadata will attempt a public-gateway request;
// failure is best-effort — capability/endpoint remain null in test env.
const METADATA_URI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y27nf3efuylqabf3oclgtqy55fbzdi';
const CAP_HASH_BYTE = 0xab;
const CAP_HASH = Array.from<number>({ length: 32 }).fill(CAP_HASH_BYTE);

function createdData(
  overrides: Partial<ServiceListingCreatedData> = {},
): ServiceListingCreatedData {
  return {
    listing: { toString: () => PUBKEY },
    owner: { toString: () => OWNER },
    satiAgentId: { toString: () => '42' },
    capabilityHash: CAP_HASH,
    priceLamports: { toString: () => '1000000' },
    pricingModel: 0,
    metadataUri: METADATA_URI,
    createdAt: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

function updatedData(
  overrides: Partial<ServiceListingUpdatedData> = {},
): ServiceListingUpdatedData {
  return {
    listing: { toString: () => PUBKEY },
    owner: { toString: () => OWNER },
    newPrice: null,
    newUri: null,
    isActive: true,
    updatedAt: { toString: () => String(Math.floor(Date.now() / 1000)) },
    ...overrides,
  };
}

describe.skipIf(process.env.INTEGRATION !== 'true')(
  'indexer integration — ServiceListing DB upsert round-trip',
  () => {
    // getSql() is called lazily inside beforeAll/tests so the describe callback
    // can be collected without DATABASE_URL (vitest still runs the callback to
    // discover test names even for skipped suites).
    let sql: ReturnType<typeof getSql>;

    beforeAll(() => {
      process.env.HELIUS_WEBHOOK_SECRET = 'Bearer integration-test-secret-abc123456';
      sql = getSql();
    });

    afterAll(async () => {
      await sql`DELETE FROM service_listings WHERE pubkey = ${PUBKEY}`;
      await sql`DELETE FROM processed_signatures WHERE signature LIKE ${`${RUN}-%`}`;
    });

    it('inserts a row on ServiceListingCreated', async () => {
      await onListingCreated(`${RUN}-create`, createdData());

      const rows = await sql`
        SELECT pubkey, owner, price_lamports, pricing_model, metadata_uri,
               is_active, jobs_completed, capability_hash
        FROM service_listings WHERE pubkey = ${PUBKEY}
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.owner).toBe(OWNER);
      expect(String(row.price_lamports)).toBe('1000000');
      expect(row.pricing_model).toBe(0);
      expect(row.metadata_uri).toBe(METADATA_URI);
      expect(row.is_active).toBe(true);
      expect(String(row.jobs_completed)).toBe('0');
      // 32 bytes all equal to CAP_HASH_BYTE
      const hash = Buffer.from(row.capability_hash as Buffer);
      expect(hash).toHaveLength(32);
      expect(hash.every((b: number) => b === CAP_HASH_BYTE)).toBe(true);
    });

    it('is idempotent — re-delivered ServiceListingCreated does not overwrite', async () => {
      // Same pubkey, different price — ON CONFLICT DO NOTHING should keep original.
      await onListingCreated(
        `${RUN}-create-dupe`,
        createdData({ priceLamports: { toString: () => '9999999' } }),
      );

      const rows = await sql`
        SELECT price_lamports FROM service_listings WHERE pubkey = ${PUBKEY}
      `;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]!.price_lamports)).toBe('1000000');
    });

    it('updates price_lamports on ServiceListingUpdated (newPrice only)', async () => {
      await onListingUpdated(
        `${RUN}-update-price`,
        updatedData({ newPrice: { toString: () => '5000000' } }),
      );

      const rows = await sql`
        SELECT price_lamports, is_active FROM service_listings WHERE pubkey = ${PUBKEY}
      `;
      expect(String(rows[0]!.price_lamports)).toBe('5000000');
      expect(rows[0]!.is_active).toBe(true);
    });

    it('deactivates listing on ServiceListingUpdated with isActive=false', async () => {
      await onListingUpdated(`${RUN}-update-deactivate`, updatedData({ isActive: false }));

      const rows = await sql`SELECT is_active FROM service_listings WHERE pubkey = ${PUBKEY}`;
      expect(rows[0]!.is_active).toBe(false);
    });

    it('updates price and metadata_uri together on ServiceListingUpdated (both fields)', async () => {
      const newUri = 'ipfs://bafkreihdwdcefgh4dqkjv67uzcmw37lon5l57ukomvhjnchnx7y2ap7q64';
      await onListingUpdated(
        `${RUN}-update-both`,
        updatedData({
          newPrice: { toString: () => '2500000' },
          newUri,
          isActive: true,
        }),
      );

      const rows = await sql`
        SELECT price_lamports, metadata_uri, is_active FROM service_listings WHERE pubkey = ${PUBKEY}
      `;
      expect(String(rows[0]!.price_lamports)).toBe('2500000');
      expect(rows[0]!.metadata_uri).toBe(newUri);
      expect(rows[0]!.is_active).toBe(true);
    });
  },
);
