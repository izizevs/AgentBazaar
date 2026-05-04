/**
 * e2e-flow.ts — full agent lifecycle on devnet: register → discover → hire (M1+).
 *
 * In M0, hire/deliver/confirm throw NotImplementedError. This script runs the
 * register → discover steps end-to-end and shows the hire stub so the pattern
 * is ready when escrow ships in M1.
 *
 * Prerequisites:
 *   - Funded devnet keypair at KEYPAIR_PATH (or SOLANA_KEYPAIR_PATH)
 *   - PINATA_JWT env var set
 *
 * Run:
 *   npx tsx examples/e2e-flow.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentBazaar,
  DegradedDiscoveryError,
  DuplicateListingError,
  MetadataUploadError,
  NotImplementedError,
  RPCFallbackFailedError,
  type ServiceProvider,
  TransactionFailedError,
  ValidationError,
} from '@agent-bazaar/sdk';
import { Keypair } from '@solana/web3.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DEVNET_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  process.env.SOLANA_KEYPAIR_PATH ??
  path.join(os.homedir(), '.config/solana/id.json');
const PINATA_JWT = process.env.PINATA_JWT ?? '';

if (!PINATA_JWT) {
  console.error('PINATA_JWT env var is required');
  process.exit(1);
}

const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8')));
const keypair = Keypair.fromSecretKey(secretKey);

const wallet = {
  publicKey: keypair.publicKey,
  signTransaction: async (tx: any) => {
    tx.sign(keypair);
    return tx;
  },
  signAllTransactions: async (txs: any[]) => {
    for (const tx of txs) tx.sign(keypair);
    return txs;
  },
};

const client = new AgentBazaar({ wallet, rpc: DEVNET_RPC, pinataJwt: PINATA_JWT });

console.log('Wallet:', keypair.publicKey.toBase58());
console.log('RPC:   ', DEVNET_RPC);
console.log();

// ── Step 1: register ──────────────────────────────────────────────────────────

console.log('Step 1: registering service listing…');

let listing: string;
try {
  const result = await client.register({
    name: 'E2E Test Agent',
    description: 'Ephemeral agent registered by the e2e-flow example script.',
    capability: 'e2e-test-capability',
    priceUsdc: 500_000n, // 0.5 USDC
    pricingModel: 'per_request',
    sla: { maxLatencyMs: 3_000, responseFormat: 'json' },
    endpoint: 'https://e2e-test.agentbazaar.local/api',
  });
  listing = result.listing.toBase58();
  console.log('  Listing PDA:', listing);
  console.log('  Tx:', result.signature);
} catch (err) {
  if (err instanceof DuplicateListingError) {
    console.log('  Listing already exists — continuing with discover step.');
    listing = '(existing)';
  } else if (err instanceof ValidationError) {
    console.error('  Validation error:', (err as Error).message);
    process.exit(1);
  } else if (err instanceof MetadataUploadError) {
    console.error('  Metadata upload failed:', (err as Error).message);
    process.exit(1);
  } else if (err instanceof TransactionFailedError) {
    console.error('  Transaction failed:', (err as Error).message);
    process.exit(1);
  } else {
    throw err;
  }
}

// ── Step 2: discover ──────────────────────────────────────────────────────────

console.log('\nStep 2: discovering e2e-test-capability agents…');

let chosen: ServiceProvider | undefined;
try {
  const services = await client.discover({
    capability: 'e2e-test-capability',
    sort: 'price_asc',
    limit: 5,
  });
  console.log(`  Found ${services.length} service(s).`);
  for (const svc of services) {
    const price = (Number(svc.priceUsdc) / 1e6).toFixed(6);
    console.log(`  • ${svc.listing.toBase58().slice(0, 8)}…  $${price}  active=${svc.isActive}`);
  }
  chosen = services[0];
} catch (err) {
  if (err instanceof DegradedDiscoveryError) {
    console.warn(
      '  Discovery API degraded; filters dropped:',
      (err as DegradedDiscoveryError).filtersDropped,
    );
  } else if (err instanceof RPCFallbackFailedError) {
    console.error('  Both API and RPC failed:', (err as Error).message);
    process.exit(1);
  } else {
    throw err;
  }
}

// ── Step 3: hire (M1 stub) ────────────────────────────────────────────────────

console.log('\nStep 3: hiring agent (escrow — M1)…');

if (!chosen) {
  console.log('  No agent found to hire. Skipping.');
} else {
  try {
    const job = await client.hire(chosen.listing.toBase58(), {
      budget: 500_000n,
      sla: { maxLatencyMs: 3_000 },
      timeout: 300,
    });
    console.log('  Job created:', job.escrowId.toBase58());
  } catch (err) {
    if (err instanceof NotImplementedError) {
      // Expected in M0 — escrow ships in M1.
      console.log('  hire() not implemented in M0 — escrow ships in M1.');
    } else {
      throw err;
    }
  }
}

console.log('\nE2E flow complete.');
