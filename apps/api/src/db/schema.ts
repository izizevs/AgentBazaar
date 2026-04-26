// Drizzle schema for the AgentBazaar API.
//
// This is intentionally a standalone copy for the CF Workers bundle —
// wrangler/esbuild cannot cross app boundaries cleanly, and the indexer's
// schema uses the `postgres` (TCP) driver client which is not CF-compatible.
//
// Future: extract to packages/db-schema and import from both apps.
// Tracked in: https://github.com/izizevs/AgentBazaar/issues (follow-up task)

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

export const processedSignatures = pgTable('processed_signatures', {
  signature: text('signature').primaryKey(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

// PostgreSQL bytea for the 32-byte on-chain capabilityHash field.
const bytea = customType<{ data: string }>({
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
    pubkey: text('pubkey').primaryKey(),
    owner: text('owner').notNull(),
    capabilityHash: bytea('capability_hash').notNull(),
    satiAgentId: bigint('sati_agent_id', { mode: 'bigint' }).notNull(),
    priceUsdcBaseUnits: bigint('price_lamports', { mode: 'bigint' }).notNull(),
    pricingModel: integer('pricing_model').notNull(),
    slaParams: jsonb('sla_params').$type<SlaParams>().notNull(),
    metadataUri: text('metadata_uri').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    jobsCompleted: bigint('jobs_completed', { mode: 'bigint' }).notNull().default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    capability: text('capability'),
    reputationScore: smallint('reputation_score').notNull().default(0),
    endpoint: text('endpoint'),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('idx_service_listings_capability_hash').on(t.capabilityHash),
    index('idx_service_listings_discover').on(t.capabilityHash, t.isActive, t.priceUsdcBaseUnits),
  ],
);

export type EscrowState = 'created' | 'delivered' | 'confirmed' | 'disputed' | 'timeout_claimed';
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
