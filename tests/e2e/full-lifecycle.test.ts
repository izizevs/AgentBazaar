/**
 * E2E: full escrow happy path — register → discover → hire → deliver → confirm.
 * Hits devnet directly. Guarded by E2E=true env var.
 *
 * Run: E2E=true pnpm --filter @agentbazaar/tests test:e2e
 *
 * Prerequisites:
 *   SOLANA_RPC_URL — Helius devnet endpoint (with API key)
 *   PINATA_JWT     — Pinata JWT for metadata upload
 *
 * Uses Circle devnet USDC (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) and
 * funds test wallets from the master devnet wallet via fundUsdc().
 * Task #28 / R4 (Task #50).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceProvider } from '@agentbazaar/sdk';
import { AgentBazaar, DegradedDiscoveryError } from '@agentbazaar/sdk';
import { Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVNET_USDC_MINT } from '../fixtures/usdc-mint.js';
import { createFundedWallets, type FundedWallet, fundUsdc } from '../fixtures/wallets.js';
import { assertEscrowState, assertVaultBalance } from '../helpers/escrow-assertions.js';
import { assertListingExists } from '../helpers/state-assertions.js';

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

// Budget: 1 USDC in micro-units (6 decimals)
const BUDGET = 1_000_000n;
// Fund buyer with 1.5 USDC to cover escrow budget + slop
const BUYER_USDC_FUND = 1_500_000n;

describe.skipIf(!isE2E)('E2E: full escrow lifecycle (happy path)', { timeout: 180_000 }, () => {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const pinataJwt = process.env.PINATA_JWT ?? '';

  const capability = `e2e-escrow-happy-${Date.now()}`;

  let connection: Connection;
  let buyerWallet: FundedWallet;
  let sellerWallet: FundedWallet;
  let buyerBazaar: AgentBazaar;
  let sellerBazaar: AgentBazaar;
  let listingPda: PublicKey;
  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  beforeAll(async () => {
    connection = new Connection(rpcUrl, 'confirmed');
    const payer = loadCliPayer();
    const funded = await createFundedWallets(connection, 2, { payer });
    buyerWallet = funded[0]!;
    sellerWallet = funded[1]!;

    // Load the master keypair (same as CLI payer) to fund USDC from its balance.
    const master =
      payer ??
      (() => {
        throw new Error('Master keypair not found — check ~/.config/solana/id.json');
      })();

    // Fund buyer with real Circle devnet USDC; seller needs ATA for receipt.
    await fundUsdc(connection, master, buyerWallet.publicKey, BUYER_USDC_FUND);
    // Create seller ATA (0 USDC) so it is ready to receive on confirm().
    await fundUsdc(connection, master, sellerWallet.publicKey, 0n);

    const usdcMintStr = DEVNET_USDC_MINT.toBase58();

    sellerBazaar = new AgentBazaar({
      wallet: new Wallet(sellerWallet.keypair),
      rpc: connection,
      pinataJwt,
      discoveryApiUrl: 'http://localhost:9999',
      usdcMint: usdcMintStr,
    });

    buyerBazaar = new AgentBazaar({
      wallet: new Wallet(buyerWallet.keypair),
      rpc: connection,
      pinataJwt: '',
      discoveryApiUrl: 'http://localhost:9999',
      usdcMint: usdcMintStr,
    });

    const registered = await sellerBazaar.register({
      name: 'E2E Happy Path Agent',
      description: 'Full lifecycle happy-path test agent.',
      capability,
      priceUsdc: BUDGET,
      pricingModel: 'per_request',
      sla: { maxLatencyMs: 5000 },
      endpoint: 'https://e2e-happy.agentbazaar.local/api',
    });
    listingPda = registered.listing;
  }, 180_000);

  it('discover() returns the registered listing', async () => {
    // discoveryApiUrl is pointed at localhost:9999 (unavailable); SDK degrades to
    // RPC fallback and throws DegradedDiscoveryError with rpcResults attached.
    let results: ServiceProvider[] = [];
    try {
      results = await buyerBazaar.discover({ limit: 200 });
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
    expect(found!.owner.toBase58()).toBe(sellerWallet.publicKey.toBase58());
  });

  it('hire() creates escrow PDA and funds vault', async () => {
    const handle = await buyerBazaar.hire(listingPda.toBase58(), {
      budget: BUDGET,
      sla: { maxLatencyMs: 5000 },
      timeout: 3600,
    });
    escrowPda = handle.escrowPda;
    vaultPda = handle.vaultPda;

    expect(escrowPda).toBeDefined();
    expect(vaultPda).toBeDefined();
    expect(handle.signature.length).toBeGreaterThan(0);

    await assertEscrowState(connection, escrowPda, 'created');
    await assertVaultBalance(connection, vaultPda, BUDGET);
  });

  it('deliver() transitions escrow to Delivered state', async () => {
    const resultHash = new Uint8Array(32).fill(0xab);
    await sellerBazaar.deliver(escrowPda.toBase58(), {
      resultUri: 'ipfs://bafyreie2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e/result.json',
      resultHash,
    });

    await assertEscrowState(connection, escrowPda, 'delivered');
    // Vault still holds funds until buyer confirms
    await assertVaultBalance(connection, vaultPda, BUDGET);
  });

  it('confirm() releases USDC to seller and closes escrow', async () => {
    const sellerAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, sellerWallet.publicKey);
    const sellerBalanceBefore = BigInt(
      (await connection.getTokenAccountBalance(sellerAta)).value.amount,
    );

    await buyerBazaar.confirm(escrowPda.toBase58(), { score: 90 });

    await assertEscrowState(connection, escrowPda, 'confirmed');
    await assertVaultBalance(connection, vaultPda, 0n);

    const sellerBalanceAfter = BigInt(
      (await connection.getTokenAccountBalance(sellerAta)).value.amount,
    );
    expect(sellerBalanceAfter - sellerBalanceBefore).toBe(BUDGET);
  });

  it('listing.jobs_completed incremented after confirm()', async () => {
    await assertListingExists(connection, listingPda, { isActive: true });
    // The on-chain listing.jobs_completed is u32; we verify it was bumped.
    // (assertListingExists does not expose jobs_completed — check raw account)
    const { buildRegistryProgram } = await import('../helpers/tx-utils.js');
    const prog = buildRegistryProgram(connection);
    const listing = await prog.account.serviceListing.fetch(listingPda);
    expect(listing.jobsCompleted).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // Devnet test state is ephemeral and harmless; no cleanup required.
  });
});
