/**
 * E2E: register → discover happy path.
 * Hits devnet directly — expect 30–90s per run. Guarded by E2E=true env var.
 *
 * Run: E2E=true pnpm --filter @agent-bazaar/tests test:e2e
 *
 * Prerequisites:
 *   SOLANA_RPC_URL  — Helius devnet endpoint (with API key)
 *   PINATA_JWT      — Pinata JWT for metadata upload
 *
 * Scope: SDK ↔ on-chain (bazaar-registry program) only.
 * Indexer integration is Task #16 / Task #18 follow-up.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceProvider } from '@agent-bazaar/sdk';
import { AgentBazaar, DegradedDiscoveryError } from '@agent-bazaar/sdk';
import { Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFundedWallets } from '../fixtures/wallets.js';
import { assertListingExists, assertNotFound } from '../helpers/state-assertions.js';
import { deriveListingPda } from '../helpers/tx-utils.js';

/**
 * Load the Solana CLI default keypair as a pre-funded payer.
 * Avoids devnet faucet rate limits (Helius: 1 SOL/day; public: flaky).
 * Falls back gracefully to undefined if the file doesn't exist.
 */
function loadCliPayer(): Keypair | undefined {
  try {
    const keyPath = join(homedir(), '.config', 'solana', 'id.json');
    const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
    return Keypair.fromSecretKey(secret);
  } catch {
    return undefined;
  }
}

const isE2E = process.env.E2E === 'true';

// ─── Keypair → AnchorWallet ──────────────────────────────────────────────────
// Anchor's Wallet class handles signTransaction/signAllTransactions correctly
// for both legacy and versioned transactions. Use it instead of a hand-rolled
// adapter to avoid subtle signing differences.

function keypairWallet(keypair: Keypair): Wallet {
  return new Wallet(keypair);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(!isE2E)('E2E: register → discover', { timeout: 120_000 }, () => {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const pinataJwt = process.env.PINATA_JWT ?? '';

  // Unique capability per run to avoid DuplicateListingError across runs.
  const capability = `e2e-capability-${Date.now()}`;

  let connection: Connection;
  let bazaar: AgentBazaar;
  let walletKeypair: Keypair;
  let listingPda: PublicKey;

  beforeAll(async () => {
    connection = new Connection(rpcUrl, 'confirmed');
    const payer = loadCliPayer();
    const wallets = await createFundedWallets(connection, 1, { payer });
    const funded = wallets[0];
    if (!funded) throw new Error('createFundedWallets returned empty array');
    walletKeypair = funded.keypair;
    bazaar = new AgentBazaar({
      wallet: keypairWallet(walletKeypair),
      rpc: connection,
      pinataJwt,
      // Point at localhost so discover() hits the RPC fallback (no API in M0).
      discoveryApiUrl: 'http://localhost:9999',
    });
    listingPda = await deriveListingPda(walletKeypair.publicKey, capability, connection);
  }, 120_000);

  it('listing PDA does not exist before register()', async () => {
    await assertNotFound(connection, listingPda);
  });

  it('register() returns confirmed tx + listing PDA', async () => {
    const result = await bazaar.register({
      name: 'E2E Test Agent',
      description: 'Created by the register → discover E2E test suite.',
      capability,
      priceUsdc: 1_000_000n, // 1 USDC
      pricingModel: 'per_request',
      sla: { maxLatencyMs: 2000 },
      endpoint: 'https://e2e-test.agentbazaar.local/api',
    });

    expect(result.listing.toBase58()).toBe(listingPda.toBase58());
    expect(typeof result.signature).toBe('string');
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it('ServiceListing PDA exists on-chain with correct fields after register()', async () => {
    await assertListingExists(connection, listingPda, {
      isActive: true,
      owner: walletKeypair.publicKey,
      priceUsdcBaseUnits: 1_000_000n,
    });
  });

  it('discover() returns the registered listing via RPC fallback', async () => {
    // discoveryApiUrl is intentionally pointed at localhost:9999 (unavailable) so the
    // SDK degrades to the RPC fallback path and throws DegradedDiscoveryError with
    // rpcResults attached. Accept the degraded mode in tests.
    let results: ServiceProvider[] = [];
    try {
      results = await bazaar.discover({ limit: 200 });
    } catch (err) {
      if (err instanceof DegradedDiscoveryError) {
        results = err.rpcResults as ServiceProvider[];
      } else {
        throw err;
      }
    }

    const found = results.find(
      (r: ServiceProvider) => r.listing.toBase58() === listingPda.toBase58(),
    );
    expect(found, `Listing ${listingPda.toBase58()} not found in discover() results`).toBeDefined();
    expect(found!.isActive).toBe(true);
    expect(found!.owner.toBase58()).toBe(walletKeypair.publicKey.toBase58());
    // RPC fallback always has reputation 0 and endpoint undefined (not on-chain in M0).
    expect(found!.reputation).toBe(0);
    expect(found!.endpoint).toBeUndefined();
  });

  afterAll(async () => {
    // deactivate() is not implemented in M0 (throws NotImplementedError).
    // The devnet listing remains; it is ephemeral test state and causes no harm.
    // Task #18 follow-up: add cleanup once deactivate_service is wired in the SDK.
  });
});
