import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// PostgreSQL bytea for the 32-byte on-chain capabilityHash field.
// Stored as bytea (not hex text) so the DB can do exact-byte equality
// lookups without decoding — supports capability_hash memcmp filtering
// from the Discovery API.
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

export type SlaParams = {
  maxLatencyMs: number | null;
  minUptimePct: number | null;
  responseFormat: string | null;
  jsonSchemaUri: string | null;
  customParams: Array<{ key: string; value: string }>;
};

export const serviceListings = pgTable(
  'service_listings',
  {
    // Base58-encoded PDA address (derived from owner + capabilityHash).
    pubkey: text('pubkey').primaryKey(),
    owner: text('owner').notNull(),

    // 32-byte SHA-256 of the capability string. Stored as bytea so the
    // Discovery API can filter with = rather than LIKE, matching the
    // on-chain memcmp getProgramAccounts filter (L6 constraint).
    capabilityHash: bytea('capability_hash').notNull(),

    // On-chain u64 fields. bigint (int8) holds up to 2^63-1; u64 max is
    // 2^64-1. Overflow is theoretical for SATI IDs and price values in M0.
    satiAgentId: bigint('sati_agent_id', { mode: 'bigint' }).notNull(),
    // NOTE: security-auditor PR #2 M2 flagged that this field is misleading
    // for a USDC-settled marketplace. Rename planned for M1 after escrow
    // program ships; keeping price_lamports in M0 to mirror IDL field names.
    priceLamports: bigint('price_lamports', { mode: 'bigint' }).notNull(),

    // On-chain u8: 0=per_request, 1=per_job, 2=hourly, 3=subscription.
    pricingModel: integer('pricing_model').notNull(),

    // SlaParams struct flattened to jsonb for flexible querying.
    slaParams: jsonb('sla_params').$type<SlaParams>().notNull(),

    metadataUri: text('metadata_uri').notNull(),

    isActive: boolean('is_active').notNull().default(true),

    // On-chain u32; bigint headroom is intentional for long-running agents.
    // SQL default avoids BigInt serialization issues in drizzle-kit snapshots.
    jobsCompleted: bigint('jobs_completed', { mode: 'bigint' }).notNull().default(sql`0`),

    // created_at mirrors on-chain createdAt (i64 Unix timestamp).
    // updated_at is indexer-side: set on every upsert.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exact-match index for capability_hash lookup (Discovery API filter).
    index('idx_service_listings_capability_hash').on(t.capabilityHash),
    // Composite covering index for the primary discover query:
    // WHERE capability_hash = $1 AND is_active = true ORDER BY price_lamports
    index('idx_service_listings_discover').on(t.capabilityHash, t.isActive, t.priceLamports),
  ],
);
