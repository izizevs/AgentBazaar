import type { PublicKey } from '@solana/web3.js';

// ─── SLA ────────────────────────────────────────────────────────────────────

export interface SlaParams {
  maxLatencyMs?: number;
  minUptimePct?: number;
  responseFormat?: string;
  jsonSchemaUri?: string;
  customParams?: Array<{ key: string; value: string }>;
}

// ─── register() ─────────────────────────────────────────────────────────────

export interface RegisterInput {
  /** Human-readable service name (1–64 chars). */
  name: string;
  /** Service description (≤500 chars). */
  description: string;
  /** Human-readable capability identifier; SHA-256 becomes the on-chain capability_hash. */
  capability: string;
  /** Service price in USDC micro-units (6 decimals). */
  priceUsdc: bigint;
  /** Pricing model. */
  pricingModel: 'per_request' | 'per_job' | 'hourly' | 'subscription';
  /** SLA parameters stored on-chain. */
  sla: SlaParams;
  /** Publicly reachable endpoint URL for this agent (HTTPS only). */
  endpoint: string;
  /** Optional agent avatar URL (HTTPS only). */
  avatar?: string;
  /** Arbitrary extension key/value pairs stored in metadata. */
  custom?: Record<string, unknown>;
  /** Optional SATI agent ID (0 = unregistered). */
  satiAgentId?: bigint;
}

export interface RegisterResult {
  /** The ServiceListing PDA address. */
  listing: PublicKey;
  /** Transaction signature. */
  signature: string;
}

// ─── discover() ─────────────────────────────────────────────────────────────

export interface DiscoverInput {
  /** Filter by capability identifier (exact match). */
  capability?: string;
  /** Minimum reputation score (0–100). */
  minReputation?: number;
  /** Maximum price in USDC micro-units. */
  maxPrice?: bigint;
  /** Maximum SLA latency in milliseconds. */
  maxLatency?: number;
  /** Sort order. */
  sort?: 'price_asc' | 'reputation_desc' | 'latency_asc';
  /** Maximum results (1–200, default 50). */
  limit?: number;
}

export interface ServiceProvider {
  listing: PublicKey;
  owner: PublicKey;
  capability: string;
  priceUsdc: bigint;
  pricingModel: number;
  sla: SlaParams;
  /** HTTPS endpoint URL. undefined when sourced from the RPC fallback (endpoint lives in IPFS metadata only). */
  endpoint: string | undefined;
  reputation: number;
  jobsCompleted: number;
  isActive: boolean;
}

// ─── hire() ─────────────────────────────────────────────────────────────────

export interface HireInput {
  /** Budget for this job in USDC micro-units. */
  budget: bigint;
  /** SLA terms agreed for this job. */
  sla: SlaParams;
  /** Job timeout in seconds from now. */
  timeout: number;
  /** Optional nonce (u64). Defaults to Date.now() millis. Pass the same nonce to achieve idempotency. */
  nonce?: bigint;
}

export interface EscrowHandle {
  /** The escrow PDA address. */
  escrowPda: PublicKey;
  /** The vault PDA address (holds USDC until settlement). */
  vaultPda: PublicKey;
  /** Transaction signature. Empty string when returning an existing escrow (idempotent path). */
  signature: string;
}

export interface Job {
  escrowId: PublicKey;
  agentId: PublicKey;
  budget: bigint;
  status: 'pending' | 'active' | 'completed' | 'disputed' | 'timed_out';
  signature: string;
}

// ─── deliver() ──────────────────────────────────────────────────────────────

export interface DeliverInput {
  /** URI pointing to the job result (e.g., IPFS/Arweave). */
  resultUri: string;
  /** SHA-256 hash of the result payload (32 bytes). */
  resultHash: Uint8Array;
}

// ─── confirm() ──────────────────────────────────────────────────────────────

export interface ConfirmInput {
  /** Reputation score awarded (0–100). */
  score: number;
  /** Optional tags describing outcome quality. */
  tags?: string[];
}

// ─── dispute() ──────────────────────────────────────────────────────────────

export interface DisputeInput {
  /** Human-readable reason for the dispute. */
  reason: string;
  /** URI pointing to dispute evidence. */
  evidenceUri?: string;
}
