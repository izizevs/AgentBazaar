import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Replay dedup: one row per processed Solana tx signature.
// INSERT ON CONFLICT DO NOTHING gives idempotent webhook delivery.
export const processedSignatures = pgTable('processed_signatures', {
  signature: text('signature').primaryKey(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

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

    // Migration #2 — populated by the ServiceListingCreated event handler (Task #15)
    // after fetching IPFS metadata from metadataUri.

    // Human-readable capability string; its SHA-256 is the on-chain capability_hash.
    // Nullable until the indexer processes the creation event and fetches IPFS metadata.
    capability: text('capability'),

    // Denormalized reputation score (0–100). Starts at 0; updated by evaluation events in M1.
    reputationScore: smallint('reputation_score').notNull().default(0),

    // Agent endpoint URL from IPFS metadata. Nullable — not all listings expose one in M0.
    endpoint: text('endpoint'),
  },
  (t) => [
    // Exact-match index for capability_hash lookup (Discovery API filter).
    index('idx_service_listings_capability_hash').on(t.capabilityHash),
    // Composite covering index for the primary discover query:
    // WHERE capability_hash = $1 AND is_active = true ORDER BY price_lamports
    index('idx_service_listings_discover').on(t.capabilityHash, t.isActive, t.priceLamports),
  ],
);

// EscrowState mirrors the on-chain enum variants from bazaar-escrow.
export type EscrowState = 'created' | 'delivered' | 'confirmed' | 'disputed' | 'timeout_claimed';

// Typed as unknown map until the bazaar-escrow IDL lands in Task #21.
export type EscrowSlaParams = Record<string, unknown>;

export const escrows = pgTable(
  'escrows',
  {
    pubkey: text('pubkey').primaryKey(),
    buyer: text('buyer').notNull(),
    seller: text('seller').notNull(),
    listing: text('listing').notNull(),
    vault: text('vault').notNull(),
    amountUsdc: bigint('amount_usdc', { mode: 'bigint' }).notNull(),
    slaParams: jsonb('sla_params').$type<EscrowSlaParams>().notNull(),
    state: text('state').$type<EscrowState>().notNull(),
    resultUri: text('result_uri'),
    resultHash: bytea('result_hash'),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_escrows_seller_state').on(t.seller, t.state),
    index('idx_escrows_buyer_state').on(t.buyer, t.state),
  ],
);

export type SlaReportSeverity = 'minor' | 'moderate' | 'major';

export const slaReports = pgTable(
  'sla_reports',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    escrowPubkey: text('escrow_pubkey').notNull(),
    severity: text('severity').$type<SlaReportSeverity>().notNull(),
    refundPct: smallint('refund_pct').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_sla_reports_escrow_pubkey').on(t.escrowPubkey)],
);

export const agentReputation = pgTable('agent_reputation', {
  wallet: text('wallet').primaryKey(),
  jobsCompleted: bigint('jobs_completed', { mode: 'bigint' }).notNull().default(sql`0`),
  avgScore: smallint('avg_score').notNull().default(0),
  totalScore: bigint('total_score', { mode: 'bigint' }).notNull().default(sql`0`),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
});
