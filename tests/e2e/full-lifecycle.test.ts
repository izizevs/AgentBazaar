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
 * Uses a freshly deployed test USDC mint so no real USDC is needed.
 * Task #28.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceProvider } from '@agentbazaar/sdk';
import { AgentBazaar } from '@agentbazaar/sdk';
import { Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployTestMint, mintToWallets } from '../fixtures/usdc-mint.js';
import { createFundedWallets, type FundedWallet } from '../fixtures/wallets.js';
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

    const testMint = await deployTestMint(connection, buyerWallet);
    // Create seller ATA (tiny amount) so it's ready to receive funds
    await mintToWallets(connection, testMint, buyerWallet, [buyerWallet], BUDGET + 100_000n);
    await mintToWallets(connection, testMint, buyerWallet, [sellerWallet], 1n);

    const usdcMintStr = testMint.mint.toBase58();

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
    const results = await buyerBazaar.discover({ limit: 200 });
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
    const sellerAta = getAssociatedTokenAddressSync(buyerBazaar.usdcMint, sellerWallet.publicKey);
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
