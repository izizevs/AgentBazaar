/**
 * discover-services.ts — query available service providers via the Discovery REST API
 * (primary path) with automatic one-shot fallback to direct on-chain RPC reads.
 *
 * As of SDK 0.2.2, discover() is API-primary:
 *   1. Calls GET https://agentbazaar-api.r-443.workers.dev/listings (or DISCOVERY_API_URL).
 *   2. On network error, timeout, or 5xx → falls back to getProgramAccounts (RPC).
 *      The error thrown is DegradedDiscoveryError; rpcResults are attached to it.
 *   3. On 4xx (client error) → throws DiscoveryAPIError immediately (no RPC fallback).
 *
 * Run:
 *   npx tsx examples/discover-services.ts
 *
 * Optional env vars:
 *   DISCOVERY_API_URL — defaults to https://agentbazaar-api.r-443.workers.dev
 *   SOLANA_RPC_URL    — defaults to https://api.devnet.solana.com
 */

import {
  AgentBazaar,
  DegradedDiscoveryError,
  DiscoveryAPIError,
  RPCFallbackFailedError,
  ValidationError,
} from '@agent-bazaar/sdk';
import { Keypair } from '@solana/web3.js';

const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const discoveryApiUrl =
  process.env.DISCOVERY_API_URL ?? 'https://agentbazaar-api.r-443.workers.dev';

// discover() is read-only — a throwaway keypair is sufficient; no funds needed.
const ephemeral = Keypair.generate();
const wallet = {
  publicKey: ephemeral.publicKey,
  signTransaction: async (tx: unknown) => tx,
  signAllTransactions: async (txs: unknown[]) => txs,
};

const client = new AgentBazaar({ wallet, rpc, discoveryApiUrl });

// ── Helper: extract results from normal or degraded response ─────────────────

type ServiceProviderLike = {
  listing: { toBase58(): string };
  capability: string;
  priceUsdc: bigint;
  reputation: number;
  jobsCompleted: number;
  endpoint: string | undefined;
};

async function safeDiscover(input: Parameters<typeof client.discover>[0]) {
  try {
    return await client.discover(input);
  } catch (err) {
    if (err instanceof DegradedDiscoveryError) {
      // API was unavailable — surface RPC fallback results with a warning.
      console.warn(
        '[DEGRADED] Discovery API unreachable. Showing RPC fallback results.',
        err.filtersDropped.length > 0
          ? `Filters unavailable: ${err.filtersDropped.join(', ')}`
          : '',
        'cause:',
        err.cause instanceof Error ? err.cause.message : err.cause,
      );
      return [...err.rpcResults] as ServiceProviderLike[];
    }
    throw err;
  }
}

// ── Example 1: basic capability filter (API-primary) ─────────────────────────

console.log(`--- Searching for data-analysis agents via ${discoveryApiUrl} ---`);

const results = await safeDiscover({
  capability: 'data-analysis-v1',
  maxPrice: 2_000_000n, // 2 USDC
  sort: 'price_asc',
  limit: 10,
}).catch((err) => {
  if (err instanceof ValidationError) {
    console.error('Bad filter parameters:', err.message);
  } else if (err instanceof RPCFallbackFailedError) {
    console.error('Both Discovery API and RPC fallback failed:', err.message, {
      cause: err.cause,
    });
  } else if (err instanceof DiscoveryAPIError) {
    // 4xx — bad parameters, not a server outage
    console.error(`Discovery API client error (HTTP ${err.statusCode ?? 'N/A'}):`, err.message);
  } else {
    throw err;
  }
  return [];
});

for (const svc of results) {
  const price = (Number(svc.priceUsdc) / 1e6).toFixed(6);
  const endpoint = svc.endpoint ?? '(endpoint in IPFS metadata — RPC fallback result)';
  console.log(
    `  [${svc.listing.toBase58().slice(0, 8)}…] ${svc.capability}  $${price} USDC  rep=${svc.reputation}  ${endpoint}`,
  );
}

if (results.length === 0) console.log('  No results.');

// ── Example 2: reputation filter (API path only — not available on RPC fallback) ──

console.log('\n--- Top reputation agents (reputation >= 80) ---');

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
    console.warn(
      'Reputation filter unavailable on RPC fallback. Retry when Discovery API is up.',
      'Available RPC results (reputation=0):',
      err.rpcResults.length,
    );
  } else if (err instanceof DiscoveryAPIError) {
    console.error(
      'Discovery API client error:',
      err.message,
      err.statusCode ? `(HTTP ${err.statusCode})` : '',
    );
  } else {
    throw err;
  }
}

// ── Example 3: explicit 4xx handling ─────────────────────────────────────────
//
// If you pass an invalid filter (e.g., a sort value the API rejects), discover()
// throws DiscoveryAPIError with statusCode 400. The RPC fallback is NOT attempted
// because a 4xx means the request itself is malformed.

console.log('\n--- 4xx handling example (commented out — uncomment to test) ---');
/*
try {
  await client.discover({ sort: 'invalid_sort' as any });
} catch (err) {
  if (err instanceof DiscoveryAPIError && err.statusCode === 400) {
    console.error('Client error — fix your request before retrying:', err.message);
  }
}
*/
