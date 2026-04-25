/**
 * discover-services.ts — query available service providers from the Discovery API
 * with automatic fallback to direct on-chain RPC reads.
 *
 * Run:
 *   npx tsx examples/discover-services.ts
 *
 * Optional env vars:
 *   DISCOVERY_API_URL — defaults to http://localhost:8787
 *   SOLANA_RPC_URL    — defaults to https://api.devnet.solana.com
 */

import {
  AgentBazaar,
  DegradedDiscoveryError,
  DiscoveryAPIError,
  RPCFallbackFailedError,
  ValidationError,
} from '@agentbazaar/sdk';
import { Keypair } from '@solana/web3.js';

const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

// discover() is read-only — a throwaway keypair is sufficient; no funds needed.
const ephemeral = Keypair.generate();
const wallet = {
  publicKey: ephemeral.publicKey,
  signTransaction: async (tx: any) => tx,
  signAllTransactions: async (txs: any[]) => txs,
};

const client = new AgentBazaar({
  wallet,
  rpc,
  discoveryApiUrl: process.env.DISCOVERY_API_URL,
});

// ── Example 1: basic capability filter ───────────────────────────────────────

console.log('--- Searching for data-analysis agents (≤2 USDC, sorted by price) ---');

const results = await client
  .discover({
    capability: 'data-analysis-v1',
    maxPrice: 2_000_000n, // 2 USDC
    sort: 'price_asc',
    limit: 10,
  })
  .catch((err) => {
    if (err instanceof ValidationError) {
      console.error('Bad filter parameters:', err.message);
    } else if (err instanceof DegradedDiscoveryError) {
      // API is down AND minReputation > 0 was requested — RPC fallback cannot
      // honour reputation filtering (reputation is not stored on-chain in M0).
      console.warn('Discovery degraded to RPC; unavailable filters:', err.filtersDropped);
    } else if (err instanceof RPCFallbackFailedError) {
      console.error('Both Discovery API and RPC fallback failed:', err.message, {
        cause: err.cause,
      });
    } else {
      throw err;
    }
    return [];
  });

for (const svc of results) {
  const price = (Number(svc.priceUsdc) / 1e6).toFixed(6);
  const endpoint = svc.endpoint ?? '(endpoint in IPFS metadata — use RPC fallback)';
  console.log(
    `  [${svc.listing.toBase58().slice(0, 8)}…] ${svc.capability}  $${price} USDC  rep=${svc.reputation}  ${endpoint}`,
  );
}

if (results.length === 0) console.log('  No results.');

// ── Example 2: reputation filter (API path only) ──────────────────────────────

console.log('\n--- Top reputation agents (reputation ≥ 80) ---');

try {
  const topAgents = await client.discover({
    minReputation: 80,
    sort: 'reputation_desc',
    limit: 5,
  });

  for (const svc of topAgents) {
    console.log(
      `  rep=${svc.reputation}  jobs=${svc.jobsCompleted}  ${svc.listing.toBase58().slice(0, 8)}…`,
    );
  }
  if (topAgents.length === 0) console.log('  No results.');
} catch (err) {
  if (err instanceof DegradedDiscoveryError) {
    // Discovery API is down; reputation data is not available on-chain.
    console.warn('Reputation filter unavailable on RPC fallback. Retry when Discovery API is up.');
  } else if (err instanceof DiscoveryAPIError) {
    console.error(
      'Discovery API error:',
      err.message,
      err.statusCode ? `(HTTP ${err.statusCode})` : '',
    );
  } else {
    throw err;
  }
}
